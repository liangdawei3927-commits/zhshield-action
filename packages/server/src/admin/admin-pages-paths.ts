/** 管理后台页面路由（零依赖 SSR），不挂全局前缀 api/v1（枚举精确路径，勿用通配符） */
export const ADMIN_UI_PATHS = [
  'admin-ui',
  'admin-ui/login',
  'admin-ui/logout',
  'admin-ui/rules',
  'admin-ui/rules/:id',
  'admin-ui/rules/:id/save',
  'admin-ui/rules/:id/publish',
  'admin-ui/rules/:id/rollback',
  'admin-ui/rules/:id/status',
  'admin-ui/rules/:id/delete',
  'admin-ui/tools',
  'admin-ui/tools/:id',
  'admin-ui/tools/:id/publish',
  'admin-ui/tools/:id/rollback',
  'admin-ui/tools/:id/delete',
];