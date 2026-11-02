/**
 * 商品文案功能开关。false 时隐藏导航并拒绝 copy / history 访问，代码与草稿数据保留。
 * Settings 已作为一级菜单独立访问；旧版把它重定向到库存页的拦截已移除，不再受本开关控制。
 */
export const PRODUCT_COPY_ENABLED = false;
