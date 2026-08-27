/**
 * SBOM 导出器（sbom.ts）
 *
 * 将 DependencyGraph 序列化为 CycloneDX 1.5 JSON 文档（行业标准，
 * 对齐《SOP标准规则资料汇总》§8 ORT / SPDX 合规链路）。
 * 纯内存转换，不访问网络。
 */
import { randomUUID } from 'crypto';
import type { DependencyGraph } from './types';
import { ROOT_NODE_ID, ROOT_NODE_NAME } from './types';
import { normalizeLicenseId } from './license-matrix';

/** SHA-512 完整性前缀匹配 */
const SHA512_RE = /^sha512-(.+)$/;

/** CycloneDX 组件（library） */
export interface CycloneDXComponent {
  type: string;
  'bom-ref': string;
  name: string;
  version: string;
  /** 许可证（可识别时才输出） */
  licenses?: Array<{ license: { id: string } }>;
  /** 完整性哈希（存在 sha512 integrity 时输出） */
  hashes?: Array<{ alg: string; content: string }>;
}

/** CycloneDX 1.5 BOM 文档 */
export interface CycloneDXDocument {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    component: { type: 'application'; name: string };
  };
  components: CycloneDXComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

/**
 * 将依赖图谱转换为 CycloneDX 1.5 BOM。
 *
 * - metadata.component 对应图谱根（应用本体）
 * - components 覆盖图谱全部依赖节点（type=library）
 * - dependencies：根 ref 指向直接依赖；其余节点依赖关系为空数组
 * - licenses 仅在许可证可识别为 SPDX id 时输出
 * - hashes 仅当节点带 sha512 integrity 时输出（剥离 'sha512-' 前缀）
 */
export function toCycloneDX(graph: DependencyGraph): CycloneDXDocument {
  const components: CycloneDXComponent[] = graph.nodes.map((node) => {
    const component: CycloneDXComponent = {
      type: 'library',
      'bom-ref': node.id,
      name: node.name,
      version: node.version,
    };

    const licenseId = node.license ? normalizeLicenseId(node.license) : null;
    if (licenseId) {
      component.licenses = [{ license: { id: licenseId } }];
    }

    if (node.integrity) {
      const sha512 = node.integrity.match(SHA512_RE);
      if (sha512) {
        component.hashes = [{ alg: 'SHA-512', content: sha512[1] }];
      }
    }

    return component;
  });

  const directRefs = graph.edges
    .filter((edge) => edge.from === ROOT_NODE_ID)
    .map((edge) => edge.to);

  const dependencies: CycloneDXDocument['dependencies'] = [
    { ref: ROOT_NODE_ID, dependsOn: directRefs },
    ...graph.nodes.map((node) => ({ ref: node.id, dependsOn: [] as string[] })),
  ];

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: ROOT_NODE_NAME },
    },
    components,
    dependencies,
  };
}
