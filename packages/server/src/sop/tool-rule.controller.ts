import { Controller, Get, Param, HttpCode, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { hashToolRuleFiles, type ToolRuleFile } from '@zh/kernel';

const VALID_TOOLS = ['semgrep', 'trivy', 'eslint', 'dep-cruiser'] as const;

type ToolName = (typeof VALID_TOOLS)[number];

const VALID_TOOL_SET: ReadonlySet<string> = new Set<string>(VALID_TOOLS);

function isToolName(value: string): value is ToolName {
  return VALID_TOOL_SET.has(value);
}

interface ToolRuleVersion {
  toolId: ToolName;
  version: string;
  hash: string;
  size: number;
  publishedAt: string;
}

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
  getVersion(@Param('tool') tool: string): ToolRuleVersion {
    const t = this.resolveTool(tool);
    return this.versions[t];
  }

  @Get(':tool/download')
  @HttpCode(HttpStatus.OK)
  getRules(@Param('tool') tool: string): ToolRuleFile[] {
    const t = this.resolveTool(tool);
    const { version, hash } = this.versions[t];
    this.logger.debug(`Serving rule pack tool=${t} version=${version} hash=${hash} files=${RULE_PACKS[t].length}`);
    return RULE_PACKS[t];
  }

  @Get(':tool/emergency')
  @HttpCode(HttpStatus.OK)
  getEmergency(@Param('tool') tool: string): ToolRuleFile[] {
    // TODO(rules-remote): once the remote rule registry ships (tier-3 sync),
    // fetch dedicated emergency packs from it instead of mirroring the static
    // local pack. Static RULE_PACKS remain the offline desktop fallback.
    this.logger.warn(
      `Emergency rule pack requested for ${tool}: serving static local pack (identical to regular rules)`,
    );
    return this.getRules(tool);
  }

  private resolveTool(tool: string): ToolName {
    const normalized = tool.toLowerCase();
    if (!isToolName(normalized)) {
      throw new NotFoundException(`Unknown tool: ${tool}`);
    }
    return normalized;
  }
}
