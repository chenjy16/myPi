/**
 * 商品文案功能开关。false 时隐藏导航并拒绝 copy / history 访问，代码与草稿数据保留。
 * Settings 已作为一级菜单独立访问；旧版把它重定向到库存页的拦截已移除，不再受本开关控制。
 */
export const PRODUCT_COPY_ENABLED = false;

/**
 * 自动化（Automation Engine）总开关。false 时侧栏隐藏整个 Automation 分组，
 * 且 /app/automation/* 的 loader/action 早退到停用页，代码与数据保留（P3-01 灰度）。
 * 本 Phase 演示期置 true；正式灰度节奏由发布决策回落为 false。
 * 与 PRODUCT_COPY_ENABLED 一样保持同构常量（app.tsx 客户端也读，不能依赖 process.env）。
 */
export const AUTOMATION_ENABLED = true;
