/// <reference types="vite/client" />

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemFileHandle extends FileSystemHandle {
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  entries(): AsyncIterableIterator<
    [string, FileSystemFileHandle | FileSystemDirectoryHandle]
  >;
  getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string): Promise<FileSystemFileHandle>;
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
}
