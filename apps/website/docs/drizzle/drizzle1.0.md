# Drizzle ORM 1.0 关系查询 v2 速查手册

> 适用于 Drizzle ORM **1.0.0-beta.1+**

```bash
bun add drizzle-orm@beta
bun add drizzle-kit@beta -D
```

---

## 1. 关系定义（defineRelations）

v2 使用 `defineRelations` 在**一个地方**统一定义所有关系，替代 v1 的分散写法。

```ts
// relations.ts
import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  users: {
    posts: r.many.posts({
      from: r.users.id,
      to: r.posts.authorId,
    }),
  },
  posts: {
    author: r.one.users({
      from: r.posts.authorId,
      to: r.users.id,
    }),
  },
}));
```

**初始化 db：**

```ts
import { relations } from "./relations";
import { drizzle } from "drizzle-orm/bun-postgres";

const db = drizzle(process.env.DATABASE_URL, { relations });
```

### 关系定义要点

| 功能 | 语法 |
| ------ | ------ |
| 一对一 | `r.one.tableName({ from, to })` |
| 一对多 | `r.many.tableName({ from, to })` |
| 多对多（through） | `r.many.tableName({ from: r.a.id.through(r.mid.aId), to: r.b.id.through(r.mid.bId) })` |
| 字段名 | `from` / `to`（支持单值或数组） |
| 关系别名 | `alias: "xxx"` |
| 仅定义 many | 可以不配对 `one`，单独使用 `r.many` |
| 可选性控制 | `optional: false` 声明关联一定存在 |
| 预定义过滤 | 在关系定义中加 `where: { verified: true }` |

### 多对多示例（through）

```ts
export const relations = defineRelations(schema, (r) => ({
  users: {
    groups: r.many.groups({
      from: r.users.id.through(r.usersToGroups.userId),
      to: r.groups.id.through(r.usersToGroups.groupId),
    }),
  },
  groups: {
    participants: r.many.users(),
  },
}));

// 查询时直接用
const response = await db.query.users.findMany({
  with: { groups: true },
});
```

### 拆分关系定义

```ts
import { defineRelations, defineRelationsPart } from "drizzle-orm";

export const relations = defineRelations(schema, (r) => ({
  users: { /* ... */ }
}));

export const part = defineRelationsPart(schema, (r) => ({
  posts: { /* ... */ }
}));

const db = drizzle(url, { relations: { ...relations, ...part } });
```

---

## 2. 查询方法

### `db.query.table.findMany()` — 多条

```ts
const users = await db.query.users.findMany();
```

### `db.query.table.findFirst()` — 单条（自动 LIMIT 1）

```ts
const user = await db.query.users.findFirst();
```

---

## 3. where 过滤（对象语法）

**不需要导入 `eq`、`and` 等操作符，直接用对象。**

### 等值过滤

```ts
db.query.users.findMany({ where: { id: 1 } });
// SQL: WHERE id = 1
```

### 多条件 + 操作符

```ts
db.query.users.findMany({
  where: {
    age: 15,
    name: { like: "A%" },
  },
});
// SQL: WHERE age = 15 AND name LIKE 'A%'
```

### 完整操作符列表

```ts
where: {
  // 逻辑组合
  OR: [],
  AND: [],
  NOT: {},

  // 原生 SQL
  RAW: (table) => sql`${table.id} = 1`,

  // 按关联表过滤
  [relationName]: { /* ... */ },

  // 列操作符
  [columnName]: {
    eq: 1,           // =
    ne: 1,           // !=
    gt: 1,           // >
    gte: 1,          // >=
    lt: 1,           // <
    lte: 1,          // <=
    in: [1, 2],      // IN
    notIn: [1, 2],   // NOT IN
    like: "A%",      // LIKE
    ilike: "a%",     // ILIKE（PostgreSQL 不区分大小写）
    notLike: "X%",
    notIlike: "x%",
    isNull: true,    // IS NULL
    isNotNull: true, // IS NOT NULL

    // PostgreSQL 数组操作
    arrayOverlaps: [1, 2],
    arrayContained: [1, 2],
    arrayContains: [1, 2],
  },
};
```

### 按关联表过滤

```ts
// 获取 ID > 10 且至少有一篇内容以 "M" 开头的帖子的用户
db.query.users.findMany({
  where: {
    id: { gt: 10 },
    posts: { content: { like: "M%" } },
  },
});

// 仅获取有帖子的用户
db.query.users.findMany({
  where: { posts: true }, // 存在至少一条关联记录
});
```

### 嵌套 where

```ts
db.query.posts.findMany({
  where: { id: 1 },
  with: {
    comments: {
      where: { createdAt: { lt: new Date() } },
    },
  },
});
```

---

## 4. orderBy 排序（对象语法）

```ts
// 单字段
db.query.posts.findMany({ orderBy: { id: "asc" } });

// 多字段
db.query.posts.findMany({ orderBy: [{ id: "desc" }, { name: "asc" }] });

// 主表 + 关联表
db.query.posts.findMany({
  orderBy: { id: "asc" },
  with: {
    comments: { orderBy: { id: "desc" } },
  },
});

// 原生 SQL 排序
db.query.posts.findMany({
  orderBy: (t) => sql`${t.id} asc`,
});
```

---

## 5. columns 部分字段选择

SQL 层面裁剪，不传多余数据。

```ts
// 只要 id 和 content
db.query.posts.findMany({
  columns: { id: true, content: true },
});

// 排除 content
db.query.posts.findMany({
  columns: { content: false },
});

// 嵌套关联也支持
db.query.posts.findMany({
  columns: { id: true },
  with: {
    comments: { columns: { authorId: false } },
  },
});

// 主表不返回任何字段（仅获取关联数据）
db.query.users.findMany({
  columns: {},
  with: { posts: true },
});
```

> 同时出现 `true` 和 `false` 时，所有 `false` 被忽略。

---

## 6. with 关联查询

```ts
// 单层
db.query.users.findMany({ with: { posts: true } });

// 多层嵌套
db.query.users.findMany({
  with: {
    posts: {
      with: { comments: true },
    },
  },
});

// 关联带过滤/排序/分页
db.query.posts.findMany({
  with: {
    comments: {
      where: { createdAt: { gt: new Date("2025-01-01") } },
      orderBy: { id: "desc" },
      limit: 3,
      offset: 3,
      columns: { id: true, content: true },
    },
  },
});
```

---

## 7. limit / offset 分页

主查询和嵌套关联**都支持** limit 和 offset。

```ts
db.query.posts.findMany({
  limit: 5,
  offset: 2,
  with: {
    comments: { limit: 3, offset: 3 },
  },
});
```

---

## 8. extras 自定义计算字段

```ts
import { sql } from "drizzle-orm";

// 回调写法（推荐，类型安全）
db.query.users.findMany({
  extras: {
    fullName: (users, { sql }) =>
      sql<string>`concat(${users.name}, ' ', ${users.lastName})`,
    loweredName: (users, { sql }) => sql`lower(${users.name})`,
  },
});

// 嵌套关联也支持 extras
db.query.posts.findMany({
  extras: {
    contentLength: (table, { sql }) => sql<number>`length(${table.content})`,
  },
  with: {
    comments: {
      extras: {
        commentSize: (table, { sql }) => sql<number>`length(${table.content})`,
      },
    },
  },
});
```

> 不支持聚合函数（COUNT、SUM 等），请用核心查询 API 或 `$count`。

---

## 9. 子查询（$count）

```ts
await db.query.users.findMany({
  with: { posts: true },
  extras: {
    totalPostsCount: (table) =>
      db.$count(posts, eq(posts.authorId, table.id)),
  },
});
```

---

## 10. 预编译语句（Prepared Statements）

```ts
const prepared = db.query.users
  .findMany({
    where: { id: { eq: sql.placeholder("id") } },
    limit: sql.placeholder("uLimit"),
    offset: sql.placeholder("uOffset"),
    with: {
      posts: {
        where: { id: { eq: sql.placeholder("pid") } },
        limit: sql.placeholder("pLimit"),
      },
    },
  })
  .prepare("query_name");

await prepared.execute({ id: 1, uLimit: 3, uOffset: 0, pid: 6, pLimit: 1 });
```

---

## 11. 部分升级方案（v1 → v2 渐进迁移）

| 用途 | 路径 |
| ------ | ------ |
| v2 关系定义 | `import { defineRelations } from "drizzle-orm"` |
| v1 关系定义（兼容） | `import { relations } from "drizzle-orm/_relations"` |
| v2 查询 | `db.query.xxx.findMany()` |
| v1 查询（兼容） | `db._query.xxx.findMany()` |

---

## 12. 内部变更速查

- `fields` / `references` → `from` / `to`
- `relationName` → `alias`
- `drizzle()` 不再需要 `mode` 参数
- `DrizzleConfig` 新增 `TRelations` 泛型
- 旧的 v1 内部类型移至 `drizzle-orm/_relations`
- 查询构建器路径：`query` → `_query`（旧路径被 v2 占据）

---

## 13. where 类型标注与 $count 兼容方案

> 来源：[drizzle-team/drizzle-orm#5144](https://github.com/drizzle-team/drizzle-orm/issues/5144)

### 问题

对象语法 `where` 目前**没有官方导出类型**，无法直接给变量做类型标注。同时 `$count()` 只接受 v1 风格的 SQL 条件，不支持对象语法。

### where 变量的类型标注（社区方案）

```ts
import { RelationsFilter } from "drizzle-orm";

type DatabaseSchema = typeof schema;
type DatabaseRelations = typeof relations;

// 通用过滤类型，按表名取对应 where 类型
type DatabaseRelationsFilter<
  K extends keyof DatabaseRelations = keyof DatabaseRelations,
  R extends DatabaseRelations[keyof DatabaseRelations] = DatabaseRelations[K],
> = RelationsFilter<R, DatabaseRelations>;

// 使用
const queryWhere: DatabaseRelationsFilter<"users"> = {
  age: 21,
  name: { like: "A%" },
};

const users = await db.query.users.findMany({ where: queryWhere });
```

### $count 配合对象语法 where（未文档化 API）

`$count` 不支持对象语法，需要用 `relationsFilterToSQL` 转换：

```ts
import { relationsFilterToSQL } from "drizzle-orm"; // 未文档化

const filters = { age: 21 };

// findMany 用对象语法
const users = await db.query.users.findMany({ where: filters });

// $count 需要转换回 SQL 条件
const total = await db.$count(
  usersTable,
  relationsFilterToSQL(usersTable, filters),
);
```

> `relationsFilterToSQL` 是未文档化的内部 API，类型尚不完善，传参可能有类型报错。

### workaround：在 extras 中内联 count

绕开 `$count`，直接在 `findMany` 里用 `extras` 计算：

```ts
const products = await db.query.product.findMany({
  where: queryWhere,
  limit,
  offset,
  extras: {
    count: db.$count(
      dbSchema.product,
      relationsFilterToSQL(dbSchema.product, queryWhere),
    ),
  },
});
```

### 当前状态

- Issue 标签为 `docs`，官方认为是文档缺失问题
- `relationsFilterToSQL` 随时可能变动，谨慎使用
- 等待官方补全类型导出和 `$count` 对象语法支持

---

## 附录 A:破坏性变更(Breaking Changes)

> 摘自 Drizzle 官方迁移指南,列出从 v1 升级到 v2 时需要注意的破坏性变更。

### A.1 列编码器与解码器的变更

在 PostgreSQL 方言的所有驱动中,某些类型(如 `intervals` / `timestamps` / `dates` / `datetimes` 的数组)存在映射错误。
Drizzle 返回的运行时值与类型声明不一致的问题已修复,但如果你之前在 Drizzle 之后手动处理了这些响应并忽略了类型提示,这次修复可能会造成破坏性影响。**请检查项目中相关部分。**

### A.2 导入路径与内部类型的变更

1. **泛型参数增加**:每个 `drizzle` 数据库实例 / `session` / `migrator` / `transaction` 实例现在都增加了两个泛型参数,用于支持 RQB v2 查询。

2. **`DrizzleConfig` 新增 `TRelations` 泛型**:

   ```ts
   // 之前
   type DrizzleConfig<Schema>
   // 现在
   type DrizzleConfig<Schema, Relations>
   ```

3. **大量类型从 `drizzle-orm` / `drizzle-orm/relations` 移至 `drizzle-orm/_relations`**。如果你仍在使用这些旧类型,请更新导入路径:

   ```
   Relation, Relations, One, Many, TableRelationsKeysOnly,
   ExtractTableRelationsFromSchema, ExtractObjectValues,
   ExtractRelationsFromTableExtraConfigSchema, getOperators,
   Operators, getOrderByOperators, OrderByOperators,
   FindTableByDBName, DBQueryConfig, TableRelationalConfig,
   TablesRelationalConfig, RelationalSchemaConfig,
   ExtractTablesWithSchema, ReturnTypeOrValue,
   BuildRelationResult, NonUndefinedKeysOnly,
   BuildQueryResult, RelationConfig,
   extractTablesRelationalConfig, relations,
   createOne, createMany, NormalizedRelation,
   normalizeRelation, createTableRelationsHelpers,
   TableRelationsHelpers, BuildRelationalQueryResult,
   mapRelationalRow
   ```

4. **查询构建器路径**:`${dialect}-core/query-builders/query` 文件已被移至 `${dialect}-core/query-builders/_query`,原路径现在由 RQB v2 的新实现替代。

---

## 附录 B:本项目内的 Drizzle 1.0 实战约定

> 配合 `.claude/rules/drizzle-queries.md` 使用。

- **关系定义唯一源**:`packages/contract/src/drizzle/table.relation.ts` 用 `defineRelations(dbschema, (r) => ({...}))` 统一定义
- **`drizzle()` 调用**:`drizzle(client, { schema, relations: true })` — 传 schema 供表名解析,传 relations 供 RQB v2
- **where 子句**:业务查询统一用对象语法 `{ tenantId, siteId, isActive: true }`;复杂条件用 `and()` / `or()` 包
- **with 关联**:一次拿,避免 N+1;`with: { relation: { columns: { id, name } } }` 显式裁列
- **不混用 v1 路径**:项目已统一 v2,不要 `import { relations } from "drizzle-orm/_relations"`(兼容路径)
- **关联 + 分页**:where/orderBy/limit/offset/with 都可嵌套,主表和 `with:` 子对象各一组
