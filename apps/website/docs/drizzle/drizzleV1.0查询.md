以下是您提供内容的完整中文翻译：

---

# Drizzle 关系查询（Relational Queries）

> **警告**
> 本文档介绍的功能适用于 Drizzle ORM **1.0.0-beta.1 及更高版本**。

安装命令（任选其一）：

```bash

# bun
bun add drizzle-orm@beta
bun add drizzle-kit@beta -D
```

支持的数据库：

- PostgreSQL

---

Drizzle ORM 的设计理念是成为 **SQL 之上的轻量级类型化层**。我们相信，Drizzle 提供了在 TypeScript 中操作 SQL 数据库的最佳方式，而现在我们要让它变得更好。

**关系查询（Relational Queries）** 旨在为你提供卓越的开发体验，让你能轻松地从 SQL 数据库中查询嵌套的关系数据，而无需手动编写复杂的 JOIN 或进行繁琐的数据映射
---

## 基础用法

### 初始化数据库连接（需传入 relations）

```ts
// index.ts
import { relations } from './relations';
import { drizzle } from 'drizzle-orm/...'; // 路径取决于你使用的数据库驱动

const db = drizzle({ relations });

const result = await db.query.users.findMany({
  with: {
    posts: true
  },
});
```

返回结果示例：

```json
[{
  "id": 10,
  "name": "Dan",
  "posts": [
    {
      "id": 1,
      "content": "SQL is awesome",
      "authorId": 10
    },
    {
      "id": 2,
      "content": "But check relational queries",
      "authorId": 10
    }
  ]
}]
```

> 💡 关系查询是 Drizzle 原有查询构建器的扩展。
> 你需要在调用 `drizzle()` 初始化时传入完整的 schema 表和 relations 定义，之后即可使用 `db.query` API。

---

## 查询方法

Drizzle 提供两个核心查询方法：

### `.findMany()`：查询多条记录

```ts
const users = await db.query.users.findMany();
```

返回类型示例：

```ts
const result: {
  id: number;
  name: string;
  verified: boolean;
  invitedBy: number | null;
}[];
```

### `.findFirst()`：查询单条记录（自动添加 `LIMIT 1`）

```ts
const user = await db.query.users.findFirst();
```

返回类型示例：

```ts
const result: {
  id: number;
  name: string;
  verified: boolean;
  invitedBy: number | null;
};
```

---

## 包含关联数据（`with`）

使用 `with` 操作符可以轻松组合多个相关表的数据，并自动聚合结果。

### 示例：获取所有帖子及其评论

```ts
const posts = await db.query.posts.findMany({
  with: {
    comments: true,
  },
});
```

### 示例：获取第一条帖子及其评论

```ts
const post = await db.query.posts.findFirst({
  with: {
    comments: true,
  },
});
```

### 嵌套关联（支持任意层级）

Drizzle 会通过 **Core Type API** 自动推断嵌套类型。

```ts
// 获取所有用户 → 帖子 → 评论
const users = await db.query.users.findMany({
  with: {
    posts: {
      with: {
        comments: true,
      },
    },
  },
});
```

---

## 部分字段选择（Partial Select）

使用 `columns` 参数可指定要包含或排除的字段。
Drizzle 会在 **SQL 查询层面** 进行裁剪，**不会从数据库传输多余数据**。

> ⚠️ Drizzle 始终只生成 **一条 SQL 语句**。

### 示例：只获取帖子的 `id` 和 `content`，并包含评论

```ts
const posts = await db.query.posts.findMany({
  columns: {
    id: true,
    content: true,
  },
  with: {
    comments: true,
  }
});
```

### 示例：排除 `content` 字段

```ts
const posts = await db.query.posts.findMany({
  columns: {
    content: false,
  },
});
```

### 同时使用 `true` 和 `false`？

当同时存在 `true` 和 `false` 时，**所有 `false` 会被忽略**。

```ts
// ❌ id: false 无效！因为 name: true 已隐含“只选 name”
const users = await db.query.users.findMany({
  columns: {
    name: true,
    id: false // ← 被忽略
  },
});

// 返回类型
const users: {
  name: string;
};
```

### 仅获取关联数据（主表字段全排除）

```ts
const res = await db.query.users.findMany({
  columns: {}, // 主表不返回任何字段
  with: {
    posts: true
  }
});

// 返回类型
const res: {
  posts: {
    id: number,
    text: string
  }
}[];
```

### 嵌套的部分字段选择

你也可以对嵌套的关联表进行字段筛选：

```ts
const posts = await db.query.posts.findMany({
  columns: {
    id: true,
    content: true,
  },
  with: {
    comments: {
      columns: {
        authorId: false // 不返回 authorId
      }
    }
  }
});
```

---

## 查询过滤（Filters）

与 Drizzle 的 SQL 式查询构建器一样，关系查询也支持丰富的过滤条件。

你可以直接使用对象语法，无需导入操作符。

### 基础等值过滤

```ts
const users = await db.query.users.findMany({
  where: {
    id: 1
  }
});
// 生成 SQL: SELECT * FROM users WHERE id = 1
```

### 嵌套过滤：获取 ID=1 的帖子及其早于某时间的评论

```ts
await db.query.posts.findMany({
  where: { id: 1 },
  with: {
    comments: {
      where: {
        createdAt: { lt: new Date() }
      }
    }
  }
});
```

### 所有过滤操作符列表

```ts
where: {
  OR: [],          // 逻辑或（数组）
  AND: [],         // 逻辑与（数组）
  NOT: {},         // 逻辑非（对象）
  RAW: (table) => sql`${table.id} = 1`, // 原生 SQL

  // 按关联表过滤
  [relationName]: { /* ... */ },

  // 按列过滤
  [columnName]: {
    OR: [],
    AND: [],
    NOT: {},
    eq: 1,           // =
    ne: 1,           // !=
    gt: 1,           // >
    gte: 1,          // >=
    lt: 1,           // <
    lte: 1,          // <=
    in: [1, 2],      // IN
    notIn: [1, 2],   // NOT IN
    like: "A%",      // LIKE（区分大小写）
    ilike: "a%",     // ILIKE（不区分大小写，仅 PostgreSQL）
    notLike: "X%",
    notIlike: "x%",
    isNull: true,    // IS NULL
    isNotNull: true, // IS NOT NULL

    // 数组操作（PostgreSQL）
    arrayOverlaps: [1, 2],   // &&
    arrayContained: [1, 2],  // <@
    arrayContains: [1, 2],   // @>
  }
}
```

#### 示例链接（文档中可点击）

- 简单等值（eq）
- 使用 AND
- 使用 OR
- 使用 NOT
- 使用 RAW 的复杂示例

```ts
const response = db.query.users.findMany({
  where: { age: 15 }
});
// 生成 SQL:
// SELECT "users"."id", "users"."name"
// FROM "users"
// WHERE ("users"."age" = 15)
```

---

## 关联表过滤（Relations Filters）

你可以**不仅按当前表过滤，还能按关联表过滤**！

### 示例：获取 ID > 10 且至少有一篇内容以 “M” 开头的帖子的用户

```ts
const usersWithPosts = await db.query.users.findMany({
  where: {
    id: { gt: 10 },
    posts: {
      content: { like: 'M%' }
    }
  }
});
```

### 示例：仅获取**至少有一篇帖子**的用户

```ts
const response = db.query.users.findMany({
  with: { posts: true },
  where: {
    posts: true // 表示“存在至少一条关联记录”
  }
});
```

---

## 分页：Limit & Offset

Drizzle 支持对主查询和嵌套关联分别设置 `limit` 和 `offset`。

### 获取前 5 篇帖子

```ts
await db.query.posts.findMany({ limit: 5 });
```

### 每篇帖子最多返回 3 条评论

```ts
await db.query.posts.findMany({
  with: {
    comments: { limit: 3 }
  }
});
```

### ✅ 重要更新：`offset` 现在也支持嵌套关联

```ts
await db.query.posts.findMany({
  limit: 5,
  offset: 2, // 主查询偏移
  with: {
    comments: {
      offset: 3, // 嵌套偏移 ✅
      limit: 3,
    },
  },
});
```

### 获取第 6 到第 10 篇帖子（含评论）

```ts
await db.query.posts.findMany({
  with: { comments: true },
  limit: 5,
  offset: 5,
});
```

---

## 排序（Order By）

### 基础排序

```ts
await db.query.posts.findMany({
  orderBy: { id: "asc" }
});
```

### 主表升序 + 关联表降序

```ts
await db.query.posts.findMany({
  orderBy: { id: "asc" },
  with: {
    comments: {
      orderBy: { id: "desc" }
    }
  }
});
```

### 使用原生 SQL 排序

```ts
await db.query.posts.findMany({
  orderBy: (t) => sql`${t.id} asc`,
  with: {
    comments: {
      orderBy: (t, { desc }) => desc(t.id),
    }
  }
});
```

> ⚠️ 如果在同一张表中指定多个 `orderBy`，它们会**按书写顺序**加入 SQL。

---

## 添加自定义字段（Extras）

你可以通过 `extras` 添加计算字段（如函数、表达式等）。

> ⚠️ **目前不支持聚合函数（如 COUNT、SUM）**，请使用核心查询 API。

### 方式一：直接使用 `sql`

```ts
import { sql } from 'drizzle-orm';

await db.query.users.findMany({
  extras: {
    loweredName: sql`lower(${users.name})`,
  }
});
```

### 方式二：回调函数（推荐，类型更安全）

```ts
await db.query.users.findMany({
  extras: {
    loweredName: (users, { sql }) => sql`lower(${users.name})`,
  }
});
```

> 🔔 返回对象中会自动包含 `loweredName` 字段。
> 🔔 如果你对 `extras` 字段调用 `.as("alias")`，Drizzle **会忽略它**。

### 实战示例 1：拼接全名

```ts
const res = await db.query.users.findMany({
  extras: {
    fullName: (users, { sql }) => sql<string>`concat(${users.name}, " ", ${users.lastName})`,
  },
  with: {
    usersToGroups: {
      with: { group: true }
    }
  }
});

// 返回类型包含 fullName: string
```

### 实战示例 2：计算内容长度

```ts
const res = await db.query.posts.findMany({
  extras: {
    contentLength: (table, { sql }) => sql<number>`length(${table.content})`,
  },
  with: {
    comments: {
      extras: {
        commentSize: (table, { sql }) => sql<number>`length(${table.content})`,
      }
    }
  }
});
```

返回类型将包含：

- `contentLength: number`
- 每条评论含 `commentSize: number`

---

## 子查询（Subqueries）

你可以在关系查询中使用子查询，发挥自定义 SQL 的强大能力。

### 示例：获取用户及其帖子，并附带每个用户的帖子总数

```ts
import { posts } from './schema';
import { eq } from 'drizzle-orm';

await db.query.users.findMany({
  with: { posts: true },
  extras: {
    totalPostsCount: (table) => db.$count(posts, eq(posts.authorId, table.id)),
  }
});
```

生成的 SQL 类似：

```sql
SELECT
  "d0"."id" AS "id",
  "d0"."name" AS "name",
  "posts"."r" AS "posts",
  ((SELECT count(*) FROM "posts" WHERE "posts"."author_id" = "d0"."id")) AS "totalPostsCount"
FROM "users" AS "d0"
LEFT JOIN LATERAL (
  SELECT coalesce(json_agg(row_to_json("t".*)), '[]') AS "r"
  FROM (
    SELECT
      "d1"."id" AS "id",
      "d1"."content" AS "content",
      "d1"."author_id" AS "authorId"
    FROM "posts" AS "d1"
    WHERE "d0"."id" = "d1"."author_id"
  ) AS "t"
) AS "posts" ON true
```

---

## 预编译语句（Prepared Statements）

预编译语句可**大幅提升查询性能**（尤其在高频调用场景）。

### 在 `where` 中使用占位符

```ts
const prepared = db.query.users.findMany({
  where: { id: { eq: sql.placeholder("id") } },
  with: { posts: { where: { id: 1 } } }
}).prepare("query_name");

const usersWithPosts = await prepared.execute({ id: 1 });
```

### 在 `limit` / `offset` 中使用占位符

```ts
// limit
const prepared = db.query.users.findMany({
  with: { posts: { limit: sql.placeholder("limit") } }
}).prepare("query_name");
await prepared.execute({ limit: 1 });

// offset
const prepared = db.query.users.findMany({
  offset: sql.placeholder('offset'),
  with: { posts: true }
}).prepare('query_name');
await prepared.execute({ offset: 1 });
```

### 多个占位符混合使用

```ts
const prepared = db.query.users.findMany({
  limit: sql.placeholder("uLimit"),
  offset: sql.placeholder("uOffset"),
  where: {
    OR: [
      { id: { eq: sql.placeholder("id") } },
      { id: 3 }
    ]
  },
  with: {
    posts: {
      where: { id: { eq: sql.placeholder("pid") } },
      limit: sql.placeholder("pLimit")
    }
  }
}).prepare("query_name");

await prepared.execute({
  pLimit: 1,
  uLimit: 3,
  uOffset: 1,
  id: 2,
  pid: 6
});
```

---

> 如需更多细节，请参考官方 [Select Filters 文档](https://...) 和 [预编译语句指南](https://...)。
