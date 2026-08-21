import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import type { ExperienceType as EvolveExperienceType } from '@zh/evolve';
import { EvolveService } from '../evolve/evolve.service';

type ExperienceType = 'false_positive' | 'true_positive' | 'fix_suggestion' | 'new_pattern';

interface ExperienceRecord {
  type: ExperienceType;
  ruleId: string;
  toolId: string;
  codePattern?: string;
  description: string;
  fixSteps?: string;
  projectId: string;
  timestamp: string;
}

interface ExperienceBatchDto {
  records: ExperienceRecord[];
}

interface ExperienceBatchResponse {
  accepted: number;
  rejected: number;
}

const TYPE_MAP: Record<ExperienceType, EvolveExperienceType> = {
  false_positive: 'false-positive',
  true_positive: 'true-positive',
  fix_suggestion: 'fix-applied',
  new_pattern: 'best-practice',
};

@Controller('experience')
export class ExperienceController {
  private readonly logger = new Logger(ExperienceController.name);

  constructor(private readonly evolveService: EvolveService) {}

  /**
   * POST /api/v1/experience
   * 接收桌面端回写的经验数据，写入 Evolve 引擎并触发权重校准。
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveExperience(@Body() body: ExperienceBatchDto): Promise<ExperienceBatchResponse> {
    const { records } = body;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return { accepted: 0, rejected: 0 };
    }

    const { accepted, rejected } = await this.processBatch(records);

    this.logger.log(`Experience back-write: accepted=${accepted}, rejected=${rejected}`);
    return { accepted, rejected };
  }

  private async processBatch(records: ExperienceRecord[]): Promise<ExperienceBatchResponse> {
    let accepted = 0;
    let rejected = 0;

    for (const record of records) {
      if (this.isValidRecord(record)) {
        await this.persistExperience(record);
        accepted++;
      } else {
        rejected++;
      }
    }

    return { accepted, rejected };
  }

  private isValidRecord(record: ExperienceRecord): boolean {
    const validTypes: ExperienceType[] = [
      'false_positive',
      'true_positive',
      'fix_suggestion',
      'new_pattern',
    ];
    return (
      validTypes.includes(record.type) &&
      typeof record.ruleId === 'string' &&
      record.ruleId.length > 0 &&
      typeof record.description === 'string' &&
      record.description.length > 0 &&
      typeof record.projectId === 'string'
    );
  }

  private async persistExperience(record: ExperienceRecord): Promise<void> {
    await this.evolveService.recordExperience({
      projectId: record.projectId,
      type: TYPE_MAP[record.type],
      ruleId: record.ruleId,
      pattern: record.codePattern ?? '',
      message: record.description,
      feedback: record.fixSteps ?? record.description,
      source: 'user',
      confidence: record.type === 'true_positive' ? 0.9 : 0.7,
      verified: true,
    });
    this.logger.debug(`Persisted experience: ${record.type} for rule ${record.ruleId}`);
  }
}
