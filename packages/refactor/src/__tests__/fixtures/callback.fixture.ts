export class DataService {
  fetchData(): Promise<string> {
    return fetch('/api/data')
      .then(r => r.json())
      .then(d => d.data)
      .then(v => v.toString())
      .catch(() => 'fallback');
  }
}
