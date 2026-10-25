// babel-preset-solid 不带类型（官方未发布 @types），本包只把 preset 交给 babel 执行，
// 结构化声明一个可调用 preset 即可。
declare module "babel-preset-solid" {
  const preset: unknown;
  export default preset;
}
