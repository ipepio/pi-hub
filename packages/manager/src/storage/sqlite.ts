import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runMigrations } from "./migrations.ts";

// Todo el acceso a SQLite del Manager pasa por este módulo. El driver es
// `node:sqlite`, el módulo integrado de Node: pihub se instala como servicio
// systemd en máquinas Debian arbitrarias (`scripts/install.sh`), y un driver
// nativo obligaría a compilar o a depender de binarios precompilados por
// arquitectura. A cambio es experimental, así que cambiar de driver debe ser
// tocar este fichero, no una refactorización del resto del Manager.

export interface SqliteStatement {
  get(...anonymousParameters: unknown[]): unknown;
  all(...anonymousParameters: unknown[]): unknown[];
  run(...anonymousParameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** Superficie mínima del driver que usa el resto del Manager. */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface ManagerStore {
  readonly db: SqliteDb;
  /** Ruta completa del fichero `.db` (los ficheros WAL/SHM viven a su lado). */
  readonly file: string;
  close(): void;
}

/**
 * Abre el almacén SQLite del Manager en `${dataDir}/manager/agenda.sqlite3`,
 * aplica los pragmas obligatorios y ejecuta las migraciones pendientes.
 * Lanza si la base ya está en una versión superior a la soportada.
 */
export async function openManagerStore(dataDir: string): Promise<ManagerStore> {
  const dir = path.join(dataDir, "manager");
  await fs.mkdir(dir, { recursive: true });
  // §4 del diseño: el scaffold crea `${dataDir}/manager` con los mismos permisos
  // del volumen. `mkdir` aplicaría el umask del proceso, así que se replican los
  // permisos de `dataDir` con `chmod`. `mode` incluye los bits de tipo de fichero;
  // enmascarar con `0o777` deja solo los permisos.
  const { mode } = await fs.stat(dataDir);
  await fs.chmod(dir, mode & 0o777);
  const file = path.join(dir, "agenda.sqlite3");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  // §5.1 del diseño: se configura un `busy_timeout` para absorber contención
  // breve. 5000 ms es un valor conservador; la calibración exacta con la
  // librería elegida sigue pendiente. `synchronous` y la política de checkpoint
  // se omiten a propósito: el diseño los deja sin fijar hasta tener medición.
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return { db, file, close: () => db.close() };
}
