import { Controller, Get, Param, HttpCode, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { hashToolRuleFiles, type ToolRuleFile } from '@zh/kernel';

type ToolName = 'semgrep' | 'trivy' | 'eslint' | 'dep-cruiser';

interface ToolRuleVersion {
  toolId: ToolName;
  version: string;
  hash: string;
  size: number;
  publishedAt: string;
}

const VALID_TOOLS: ToolName[] = ['semgrep', 'trivy', 'eslint', 'dep-cruiser'];

const RULE_PACKS: Record<ToolName, ToolRuleFile[]> = {
  semgrep: [
    {
      filename: 'rules/backdoor.yaml',
      content: [
        'rules:',
        '  - id: zh-backdoor-eval-atob',
        '    patterns:',
        '      - pattern: eval(atob(...))',
        '    message: Suspicious base64 eval (possible backdoor)',
        '    languages: [javascript, typescript]',
        '    severity: ERROR',
        '',
      ].join('\n'),
    },
    {
      filename: 'rules/exfil.yaml',
      content: [
        'rules:',
        '  - id: zh-exfil-child-process',
        '    patterns:',
        '      - pattern-either:',
        '          - pattern: child_process.exec("curl ...")',
        '          - pattern: child_process.exec("wget ...")',
        '    message: Suspicious network fetch via child_process',
        '    languages: [javascript, typescript]',
        '    severity: ERROR',
        '',
      ].join('\n'),
    },
  ],
  trivy: [
    {
      filename: 'policy/ignore.yml',
      content: '# zhshield trivy policy placeholder\nignore: []\n',
    },
  ],
  eslint: [
    {
      filename: 'zhshield-security.cjs',
      content: [
        'module.exports = {',
        "  rules: {",
        "    'no-eval': 'error',",
        "    'no-implied-eval': 'error',",
        "    'no-new-func': 'error',",
        '  },',
        '};',
        '',
      ].join('\n'),
    },
  ],
  'dep-cruiser': [
    {
      filename: '.dependency-cruiser.js',
      content: [
        'module.exports = {',
        '  forbidden: [',
        "    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },",
        '  ],',
        '};',
        '',
      ].join('\n'),
    },
  ],
};

function buildVersion(toolId: ToolName): ToolRuleVersion {
  const files = RULE_PACKS[toolId];
  const hash = hashToolRuleFiles(files);
  const size = Buffer.byteLength(JSON.stringify(files), 'utf-8');
  return {
    toolId,
    version: '1.2026.07.31.001',
    hash,
    size,
    publishedAt: '2026-07-31T00:00:00.000Z',
  };
}

@ApiTags('Tool Rules')
@Controller('rules')
export class ToolRuleController {
  private readonly logger = new Logger(ToolRuleController.name);
  private readonly versions: Record<ToolName, ToolRuleVersion> = {
    semgrep: buildVersion('semgrep'),
    trivy: buildVersion('trivy'),
    eslint: buildVersion('eslint'),
    'dep-cruiser': buildVersion('dep-cruiser'),
  };

  @Get(':tool/version')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取工具规则版本' })
  @ApiParam({ name: 'tool', description: '工具名称 (semgrep/trivy/eslint/dep-cruiser)' })
  @ApiResponse({ status: 200, description: '返回工具规则版本信息' })
  getVersion(@Param('tool') tool: string): ToolRuleVersion {
    const t = this.resolveTool(tool);
    return this.versions[t];
  }

  @Get(':tool/download')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '下载工具规则文件' })
  @ApiParam({ name: 'tool', description: '工具名称 (semgrep/trivy/eslint/dep-cruiser)' })
  @ApiResponse({ status: 200, description: '返回工具规则文件列表' })
  getRules(@Param('tool') tool: string): ToolRuleFile[] {
    const t = this.resolveTool(tool);
    this.logger.debug(`Serving ${RULE_PACKS[t].length} rule files for ${t}`);
    return RULE_PACKS[t];
  }

  @Get(':tool/emergency')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取工具紧急规则' })
  @ApiParam({ name: 'tool', description: '工具名称 (semgrep/trivy/eslint/dep-cruiser)' })
  @ApiResponse({ status: 200, description: '返回工具紧急规则文件列表' })
  getEmergency(@Param('tool') tool: string): ToolRuleFile[] {
    return this.getRules(tool);
  }

  private resolveTool(tool: string): ToolName {
    const t = tool.toLowerCase() as ToolName;
    if (!VALID_TOOLS.includes(t)) {
      throw new NotFoundException(`Unknown tool: ${tool}`);
    }
    return t;
  }
}
