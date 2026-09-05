import * as yaml from 'js-yaml';

/** YAML 文本 → 任意值（管理后台规则正文编辑用） */
export function parseYamlText(text: string): unknown {
  return yaml.load(text);
}

/** 任意值 → YAML 文本（管理后台规则正文回显用） */
export function stringifyYaml(value: unknown): string {
  return yaml.dump(value);
}