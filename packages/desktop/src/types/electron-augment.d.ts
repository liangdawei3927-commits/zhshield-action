import type { GuardConfigAPI } from './electron';

declare module './electron' {
  interface ElectronAPI {
    guardConfig?: GuardConfigAPI;
  }
}
