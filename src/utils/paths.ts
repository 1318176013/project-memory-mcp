import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePath(root: string, filePath: string): string {
  return toPosixPath(path.relative(root, filePath));
}
