import { describe, it, expect } from 'vitest';
import { SemgrepResultMapper, type SemgrepOutput } from '../adapters/semgrep-result-mapper';
import type { Issue } from '@zh/shared';

const mapper = new SemgrepResultMapper();

/** Semgrep taint mode 输出：dataflow_trace 含 taint_source → intermediate_vars → taint_sink */
function taintOutput(): SemgrepOutput {
  return {
    results: [{
      check_id: 'python.lang.security.audit.dangerous-exec.dangerous-exec',
      path: 'src/a.py',
      start: { line: 5, col: 1 },
      extra: {
        severity: 'WARNING',
        message: 'Detected dangerous exec',
        dataflow_trace: {
          taint_source: {
            location: { path: 'src/a.py', start: { line: 1, col: 2 } },
          },
          intermediate_vars: [
            { var_name: 'cmd', location: { path: 'src/a.py', start: { line: 3, col: 4 } } },
          ],
          taint_sink: {
            location: { path: 'src/a.py', start: { line: 5, col: 1 } },
          },
        },
      },
    }],
  };
}

describe('SemgrepResultMapper dataflow 映射（附录 B #1：安全核心信息不再流失）', () => {
  it('Given dataflow_trace，When mapOutput，Then issue.codeFlows 为 source→intermediate→sink 的 locations 链', () => {
    const issues = mapper.mapOutput(taintOutput());

    const issue = issues[0];
    expect(issue.codeFlows).toBeDefined();
    expect(issue.codeFlows).toHaveLength(1);
    const locations = issue.codeFlows![0].threadFlows[0].locations;
    expect(locations).toHaveLength(3);

    expect(locations[0].location).toEqual({ file: 'src/a.py', line: 1, column: 2 });
    expect(locations[0].message).toContain('source');

    expect(locations[1].location).toEqual({ file: 'src/a.py', line: 3, column: 4 });
    expect(locations[1].message).toContain('cmd');

    expect(locations[2].location).toEqual({ file: 'src/a.py', line: 5, column: 1 });
    expect(locations[2].message).toContain('sink');
  });

  it('Given dataflow_trace 缺 sink，When mapOutput，Then 保留已有 source/intermediate 链', () => {
    const output: SemgrepOutput = {
      results: [{
        check_id: 'r1',
        path: 'a.py',
        extra: {
          dataflow_trace: {
            taint_source: { location: { path: 'a.py', start: { line: 1, col: 1 } } },
            intermediate_vars: [],
          },
        },
      }],
    };

    const issues = mapper.mapOutput(output);
    expect(issues[0].codeFlows![0].threadFlows[0].locations).toHaveLength(1);
  });

  it('Given 无 dataflow_trace，When mapOutput，Then codeFlows 为 undefined', () => {
    const issues = mapper.mapOutput({
      results: [{ check_id: 'r1', path: 'a.py', extra: { severity: 'ERROR', message: 'x' } }],
    });

    expect(issues[0].codeFlows).toBeUndefined();
  });

  it('Given dataflow_trace 位于 result 顶层（真实 Semgrep JSON 落点），When mapOutput，Then 同样映射为 codeFlows', () => {
    const output: SemgrepOutput = {
      results: [{
        check_id: 'r1',
        path: 'a.py',
        dataflow_trace: {
          taint_source: { location: { path: 'a.py', start: { line: 10, col: 5 } } },
          intermediate_vars: [{ var_name: 'tmp', location: { path: 'a.py', start: { line: 11, col: 5 } } }],
          taint_sink: { location: { path: 'b.py', start: { line: 20, col: 9 } } },
        },
        extra: { severity: 'ERROR', message: 'x' },
      }],
    };

    const issues = mapper.mapOutput(output);
    expect(issues[0].codeFlows).toBeDefined();
    expect(issues[0].codeFlows).toHaveLength(1);
    const locations = issues[0].codeFlows![0].threadFlows[0].locations;
    expect(locations).toHaveLength(3);
    expect(locations[0].location.file).toBe('a.py');
    expect(locations[2].location.file).toBe('b.py');
  });

  it('Given validation_state=NO_VALIDATOR，When mapOutput，Then taxonomies 含 validation:NO_VALIDATOR', () => {
    const issues = mapper.mapOutput({
      results: [{
        check_id: 'r1',
        path: 'a.py',
        extra: { severity: 'ERROR', message: 'x', validation_state: 'NO_VALIDATOR' },
      }],
    });

    expect(issues[0].taxonomies).toContain('validation:NO_VALIDATOR');
  });

  it('Given sca_info（reachable + transitive），When mapOutput，Then taxonomies 含 sca:reachable 与 sca:transitive', () => {
    const issues = mapper.mapOutput({
      results: [{
        check_id: 'r1',
        path: 'a.py',
        extra: {
          severity: 'WARNING',
          message: 'vuln dep',
          sca_info: { reachable: true, sca_kind: 'transitive' },
        },
      }],
    });

    expect(issues[0].taxonomies).toContain('sca:reachable');
    expect(issues[0].taxonomies).toContain('sca:transitive');
  });

  it('Given sca_info 不可达，When mapOutput，Then taxonomies 含 sca:unreachable', () => {
    const issues = mapper.mapOutput({
      results: [{
        check_id: 'r1',
        path: 'a.py',
        extra: { severity: 'WARNING', message: 'vuln dep', sca_info: { reachable: false } },
      }],
    });

    expect(issues[0].taxonomies).toContain('sca:unreachable');
  });

  it('Given 无 validation_state/sca_info，When mapOutput，Then taxonomies 为 undefined（不空挂）', () => {
    const issues = mapper.mapOutput({
      results: [{ check_id: 'r1', path: 'a.py', extra: { severity: 'ERROR', message: 'x' } }],
    });

    expect(issues[0].taxonomies).toBeUndefined();
  });

  it('Given 含 dataflow_trace 的结果，When mapOutput，Then 既有必填字段与 fingerprint 不受影响', () => {
    const issues = mapper.mapOutput(taintOutput());

    const issue: Issue = issues[0];
    expect(issue.ruleId).toBe('python.lang.security.audit.dangerous-exec.dangerous-exec');
    expect(issue.severity).toBe('warning');
    expect(issue.message).toBe('Detected dangerous exec');
    expect(issue.file).toBe('src/a.py');
    expect(issue.fingerprint).toBe('semgrep:python.lang.security.audit.dangerous-exec.dangerous-exec:src/a.py:5');
  });
});
