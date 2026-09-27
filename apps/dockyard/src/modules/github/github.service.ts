import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RepoBrief {
  fullName: string;
  branch: string;
  private: boolean;
  updatedAt: string;
}

/** gh CLI 认证 piggyback（openship github.local-auth.ts 同款思路） */
export class GithubService {
  private tokenCache: { token: string; at: number } | null = null;

  /** gh auth token → 失败回退读 hosts.yml。缓存 10 分钟 */
  async token(): Promise<string> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 10 * 60_000) {
      return this.tokenCache.token;
    }
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const token = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && token) {
      this.tokenCache = { token, at: Date.now() };
      return token;
    }
    const hostsYml = readFileSync(join(Bun.env.HOME ?? "", ".config", "gh", "hosts.yml"), "utf8");
    const match = hostsYml.match(/oauth_token:\s*(\S+)/);
    if (!match) throw new Error("未找到 GitHub 凭据：请先 `gh auth login`");
    this.tokenCache = { token: match[1]!, at: Date.now() };
    return match[1]!;
  }

  /** 当前登录用户（UI 展示用） */
  async whoami(): Promise<string> {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) throw new Error("gh 未登录");
    return out;
  }

  /**
   * 分支最新 commit（ETag 省配额）。
   * 返回 null 表示 304 无变化。
   */
  async latestSha(
    ownerRepo: string,
    branch: string,
    etag?: string,
  ): Promise<{ sha: string; etag?: string } | null> {
    const args = [
      "gh", "api", `repos/${ownerRepo}/commits/${branch}`,
      "--jq", ".sha",
      "--include",
    ];
    if (etag) args.push("-H", `If-None-Match: ${etag}`);
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const raw = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // 304 时 gh 对空 body 解析 JSON 报错退出——headers 已打印，先判 304 再判错误
    if (/\b304\b/.test(raw.split("\n")[0] ?? "")) return null;
    if (code !== 0) throw new Error(`gh api 失败: ${await new Response(proc.stderr).text()}`);
    const etagMatch = raw.match(/^[Ee][Tt]ag:\s*(\S+)/m);
    const sha = raw.trim().split("\n").pop()?.trim();
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`解析 sha 失败: ${raw.slice(-200)}`);
    return { sha, etag: etagMatch?.[1] };
  }

  /** 账号可选仓库列表（部署向导的仓库选择器；缓存 5 分钟，160+ 仓库不能每次都拉） */
  private reposCache: { repos: RepoBrief[]; at: number } | null = null;
  async listRepos(): Promise<RepoBrief[]> {
    if (this.reposCache && Date.now() - this.reposCache.at < 5 * 60_000) return this.reposCache.repos;
    const proc = Bun.spawn(
      ["gh", "repo", "list", "--limit", "300", "--json", "nameWithOwner,defaultBranchRef,visibility,updatedAt"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0)
      throw new Error(`gh repo list 失败: ${await new Response(proc.stderr).text()}`);
    const raw = JSON.parse(out) as {
      nameWithOwner: string;
      defaultBranchRef?: { name: string } | null;
      visibility: string;
      updatedAt: string;
    }[];
    const repos = raw.map((r) => ({
      fullName: r.nameWithOwner,
      branch: r.defaultBranchRef?.name ?? "main",
      private: r.visibility !== "PUBLIC",
      updatedAt: r.updatedAt,
    }));
    this.reposCache = { repos, at: Date.now() };
    return repos;
  }

  /** clone / fetch 用的带 token URL（用完必须重写 remote，见 deploy） */
  async authedRepoUrl(ownerRepo: string): Promise<string> {
    return `https://x-access-token:${await this.token()}@github.com/${ownerRepo}.git`;
  }
}
