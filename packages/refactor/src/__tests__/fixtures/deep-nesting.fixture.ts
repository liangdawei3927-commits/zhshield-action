// fixture: deep-nesting test

export class PermissionChecker {
  checkAccess(user: { role?: string }, resource: { sensitive?: boolean; level: number }): boolean {
    if (user) {
      if (user.role) {
        if (user.role === 'admin') {
          if (resource.sensitive) {
            if (resource.level > 5) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  flatCheck(user: { role?: string }, resource: { sensitive?: boolean; level: number }): boolean {
    if (!user || !user.role) return false;
    if (user.role !== 'admin') return false;
    if (!resource.sensitive) return false;
    if (resource.level <= 5) return false;
    return true;
  }
}
