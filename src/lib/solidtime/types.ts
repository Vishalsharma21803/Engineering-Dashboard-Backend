/** Shapes returned by the Solidtime API v1 (ids are UUIDs, times UTC ISO, durations seconds). */

export interface SolidtimeMe {
  id: string;
  name: string;
  email: string;
  timezone: string;
  week_start: string;
}

export interface SolidtimeMembership {
  /** The member id in that organization (used as member_id). */
  id: string;
  organization: { id: string; name: string; currency: string };
  role: string;
}

export interface SolidtimeTimeEntry {
  id: string;
  start: string;
  end: string | null;
  duration: number | null;
  description: string | null;
  task_id: string | null;
  project_id: string | null;
  organization_id: string;
  user_id: string;
  tags: string[];
  billable: boolean;
  type?: string;
}

export interface SolidtimeProject {
  id: string;
  name: string;
  color: string;
  client_id: string | null;
  is_archived: boolean;
  is_billable: boolean;
  estimated_time: number | null;
  spent_time: number;
}

export interface SolidtimeTask {
  id: string;
  name: string;
  is_done: boolean;
  project_id: string;
  estimated_time: number | null;
  spent_time: number;
}

export interface SolidtimeTag {
  id: string;
  name: string;
}

export interface SolidtimeClient {
  id: string;
  name: string;
  is_archived: boolean;
}

export interface SolidtimeMember {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  is_placeholder: boolean;
}

/** Laravel paginated collection. */
export interface SolidtimePage<T> {
  data: T[];
  meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number };
}

export interface SolidtimeAggregate {
  seconds: number;
  grouped_type: string | null;
  grouped_data: Array<{ key: string | null; seconds: number; grouped_type: string | null; grouped_data: Array<{ key: string | null; seconds: number }> | null }> | null;
}

/** The fields Relay writes when it creates or edits an entry. */
export interface TimeEntryInput {
  member_id: string;
  project_id: string | null;
  task_id: string | null;
  start: string;
  end: string | null;
  billable: boolean;
  description: string | null;
  tags: string[];
}
