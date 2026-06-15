export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  shared?: boolean;
}

export const FOLDERS_STORAGE_KEY = 'mqlens_folders';
export const PROFILE_FOLDERS_STORAGE_KEY = 'mqlens_profile_folders';
export const FOLDERS_CHANGED_EVENT = 'mqlens-folders-changed';

const DEFAULT_FOLDERS: FolderNode[] = [
  { id: 'local-resources', name: 'Local resources', parentId: null, shared: false },
];

export function loadConnectionFolders(): {
  folders: FolderNode[];
  profileFolderMap: Record<string, string>;
} {
  try {
    const storedFolders = localStorage.getItem(FOLDERS_STORAGE_KEY);
    const storedMap = localStorage.getItem(PROFILE_FOLDERS_STORAGE_KEY);
    let folders: FolderNode[] = DEFAULT_FOLDERS;
    if (storedFolders) {
      folders = JSON.parse(storedFolders) as FolderNode[];
    } else {
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(DEFAULT_FOLDERS));
    }
    const profileFolderMap: Record<string, string> = storedMap
      ? (JSON.parse(storedMap) as Record<string, string>)
      : {};
    return { folders, profileFolderMap };
  } catch {
    return { folders: DEFAULT_FOLDERS, profileFolderMap: {} };
  }
}

export function saveConnectionFolders(
  folders: FolderNode[],
  profileFolderMap: Record<string, string>,
): void {
  localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
  localStorage.setItem(PROFILE_FOLDERS_STORAGE_KEY, JSON.stringify(profileFolderMap));
  window.dispatchEvent(new Event(FOLDERS_CHANGED_EVENT));
}

export function notifyFoldersChanged(): void {
  window.dispatchEvent(new Event(FOLDERS_CHANGED_EVENT));
}
