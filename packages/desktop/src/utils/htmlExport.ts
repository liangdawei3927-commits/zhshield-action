import { generateHtmlReport, type HtmlReportData } from '@zh/reporter';
import { showSaveDialog, writeFile } from '../services/engineApi';

export async function exportHtmlReport(data: HtmlReportData, defaultFilename: string): Promise<boolean> {
  const html = generateHtmlReport(data);
  const result = await showSaveDialog({
    defaultPath: defaultFilename,
    filters: [{ name: 'HTML Report', extensions: ['html'] }],
  });
  if (result.canceled || result.filePath == null) return false;
  await writeFile(result.filePath, html);
  return true;
}
