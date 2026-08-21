export interface VersionQueryDto {
  currentVersion: string;
}

export interface DiffQueryDto {
  from: string;
  to: string;
}

export interface EmergencyPullDto {
  category?: string;
}
