import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { RuleContentRow } from '@zh/db';
import { parseYamlText, stringifyYaml } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import { Public } from '../auth/local-only.guard';
import { AdminAuthGuard } from './admin-auth.guard';
import { verifyAdminToken } from './admin-token';
import { AdminService } from './admin.service';
import { errorPageHtml, loginPageHtml } from './admin-pages-view';
import { ruleEditPage, ruleListPage, toolDetailPage, toolListPage } from './admin-pages-views';

const TOKEN_COOKIE = 'zh_admin_token';

/** 最小响应接口（避免引入 express 类型依赖；@Res() 注入的底层对象满足此形状） */
interface ResLike {
  redirect(status: number, url: string): void;
  redirect(url: string): void;
  status(code: number): ResLike;
  send(body: string): void;
  setHeader(name: string, value: string): void;
}

/**
 * AdminPagesController — C5 零依赖 SSR 管理后台页面
 *
 * 全部路由 @Public()（绕过 LocalOnlyGuard），页面/动作路由挂 AdminAuthGuard
 * （Bearer 优先、cookie 兜底）；login/logout 不挂 guard。操作走原生表单 POST + 303 PRG。
 */
@Controller('admin-ui')
@Public()
export class AdminPagesController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  index(@Res() res: ResLike): void {
    res.redirect('/admin-ui/rules');
  }

  @Get('login')
  loginPage(): string {
    return loginPageHtml();
  }

  @Post('login')
  login(@Body() body: Record<string, unknown>, @Res() res: ResLike): void {
    const expected = process.env.ZH_ADMIN_TOKEN;
    const token = typeof body.token === 'string' ? body.token : '';
    if (!expected || !verifyAdminToken(token, expected)) {
      res.status(401).send(loginPageHtml('无效的管理令牌'));
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict`,
    );
    res.redirect(302, '/admin-ui/rules');
  }

  @Post('logout')
  logout(@Res() res: ResLike): void {
    res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    res.redirect(302, '/admin-ui/login');
  }

  @Get('rules')
  @UseGuards(AdminAuthGuard)
  rulesList(): string {
    return ruleListPage(this.admin.listRules());
  }

  @Get('rules/:id')
  @UseGuards(AdminAuthGuard)
  ruleEdit(@Param('id') id: string): string {
    try {
      const rule = this.admin.getRule(id);
      const versions = this.admin.listRuleVersions(id);
      const parsed = JSON.parse(rule.content) as Record<string, unknown>;
      return ruleEditPage(rule, versions, stringifyYaml(parsed));
    } catch (err) {
      return errorPageHtml(404, err instanceof Error ? err.message : '规则不存在');
    }
  }

  @Post('rules/:id/save')
  @UseGuards(AdminAuthGuard)
  async ruleSave(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: ResLike,
  ): Promise<void> {
    let rule: RuleContentRow;
    try {
      rule = this.admin.getRule(id);
    } catch {
      res.status(404).send(errorPageHtml(404, '规则不存在'));
      return;
    }
    try {
      await this.admin.saveRule(this.buildRuleFromForm(rule, body));
      res.redirect(303, `/admin-ui/rules/${encodeURIComponent(id)}`);
    } catch (err) {
      const versions = this.admin.listRuleVersions(id);
      const parsed = JSON.parse(rule.content) as Record<string, unknown>;
      res
        .status(400)
        .send(ruleEditPage(rule, versions, stringifyYaml(parsed), err instanceof Error ? err.message : '保存失败'));
    }
  }

  @Post('rules/:id/publish')
  @UseGuards(AdminAuthGuard)
  async rulePublish(@Param('id') id: string, @Res() res: ResLike): Promise<void> {
    try {
      await this.admin.publishRule(id);
      res.redirect(303, `/admin-ui/rules/${encodeURIComponent(id)}`);
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '发布失败'));
    }
  }

  @Post('rules/:id/rollback')
  @UseGuards(AdminAuthGuard)
  async ruleRollback(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: ResLike,
  ): Promise<void> {
    const version = typeof body.version === 'string' ? body.version : '';
    try {
      await this.admin.rollbackRule(id, version);
      res.redirect(303, `/admin-ui/rules/${encodeURIComponent(id)}`);
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '回滚失败'));
    }
  }

  @Post('rules/:id/status')
  @UseGuards(AdminAuthGuard)
  async ruleStatus(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: ResLike,
  ): Promise<void> {
    const status = typeof body.status === 'string' ? body.status : '';
    try {
      await this.admin.setRuleStatus(id, status);
      res.redirect(303, `/admin-ui/rules/${encodeURIComponent(id)}`);
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '改状态失败'));
    }
  }

  @Post('rules/:id/delete')
  @UseGuards(AdminAuthGuard)
  async ruleDelete(@Param('id') id: string, @Res() res: ResLike): Promise<void> {
    try {
      await this.admin.deleteRule(id);
      res.redirect(303, '/admin-ui/rules');
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '删除失败'));
    }
  }

  @Get('tools')
  @UseGuards(AdminAuthGuard)
  toolsList(): string {
    return toolListPage(this.admin.listTools());
  }

  @Get('tools/:id')
  @UseGuards(AdminAuthGuard)
  toolDetail(@Param('id') id: string): string {
    try {
      const tool = this.admin.getTool(id);
      const versions = this.admin.listToolVersions(id);
      return toolDetailPage(tool, versions);
    } catch (err) {
      return errorPageHtml(404, err instanceof Error ? err.message : '工具不存在');
    }
  }

  @Post('tools/:id/publish')
  @UseGuards(AdminAuthGuard)
  async toolPublish(@Param('id') id: string, @Res() res: ResLike): Promise<void> {
    try {
      await this.admin.publishTool(id);
      res.redirect(303, `/admin-ui/tools/${encodeURIComponent(id)}`);
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '发布失败'));
    }
  }

  @Post('tools/:id/rollback')
  @UseGuards(AdminAuthGuard)
  async toolRollback(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: ResLike,
  ): Promise<void> {
    const version = typeof body.version === 'string' ? body.version : '';
    try {
      await this.admin.rollbackTool(id, version);
      res.redirect(303, `/admin-ui/tools/${encodeURIComponent(id)}`);
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '回滚失败'));
    }
  }

  @Post('tools/:id/delete')
  @UseGuards(AdminAuthGuard)
  async toolDelete(@Param('id') id: string, @Res() res: ResLike): Promise<void> {
    try {
      await this.admin.deleteTool(id);
      res.redirect(303, '/admin-ui/tools');
    } catch (err) {
      res.status(400).send(errorPageHtml(400, err instanceof Error ? err.message : '删除失败'));
    }
  }

  private buildRuleFromForm(existing: RuleContentRow, body: Record<string, unknown>): SopRule {
    const parsed = JSON.parse(existing.content) as SopRule;
    const content = parseYamlText(typeof body.content === 'string' ? body.content : '');
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      throw new Error('规则正文 YAML 必须解析为对象');
    }
    return {
      ...parsed,
      id: existing.rule_id,
      name: requireField(body.name, '名称'),
      domain: requireField(body.domain, '域') as SopRule['domain'],
      action: requireField(body.action, '动作') as SopRule['action'],
      severity: requireField(body.severity, '严重级') as SopRule['severity'],
      tags: parseTags(body.tags),
      description: typeof body.description === 'string' ? body.description : '',
      content: content as Record<string, unknown>,
    };
  }
}

function requireField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 不能为空`);
  }
  return value.trim();
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}