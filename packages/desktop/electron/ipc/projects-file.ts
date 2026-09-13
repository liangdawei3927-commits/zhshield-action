import { app } from 'electron';
import path from 'node:path';

/**
 * 项目列表 JSON 落盘路径（userData 目录）。
 *
 * 定义独立于此文件，供 ipc/projects 与 profile-drift 共享，
 * 避免二者彼此 import 形成循环依赖。
 */
export const PROJECTS_FILE = path.join(app.getPath('userData'), 'projects.json');
