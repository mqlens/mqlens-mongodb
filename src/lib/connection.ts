import type { SshConfig } from '../components/ConnectionManager';

/** A saved connection profile, mirroring the backend `ConnectionProfile`. */
export interface ConnectionProfile {
  id: string;
  name: string;
  uri: string;
  color_tag?: string | null;
  ssh?: SshConfig | null;
}
