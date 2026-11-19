import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export type DriveSharingAccess = 'PRIVATE' | 'DOMAIN' | 'ANYONE' | 'ANYONE_WITH_LINK';

export interface MockDriveBlob {
  getBytes: () => Uint8Array;
  getContentType: () => string;
  getName: () => string;
}

export interface MockDriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  trashed: boolean;
  inFolder: boolean;
}

export class MockDriveFile {
  private readonly record: MockDriveFileRecord;

  constructor(record: MockDriveFileRecord) {
    this.record = record;
  }

  getId(): string {
    return this.record.id;
  }

  isTrashed(): boolean {
    return this.record.trashed;
  }

  setTrashed(trashed: boolean): void {
    this.record.trashed = trashed;
  }

  getBlob(): MockDriveBlob {
    const rec = this.record;
    return {
      getBytes: () => rec.bytes,
      getContentType: () => rec.mimeType,
      getName: () => rec.name,
    };
  }
}

export interface SheetFaultHooks {
  onBeforeSetValues?: (sheetName: string, writeAttempt: number) => void;
}

export class MockRange {
  private readonly sheet: MockSheet;
  private readonly startRow: number;
  private readonly startCol: number;
  private readonly numRows: number;
  private readonly numCols: number;

  constructor(
    sheet: MockSheet,
    startRow: number,
    startCol: number,
    numRows: number,
    numCols: number
  ) {
    this.sheet = sheet;
    this.startRow = startRow;
    this.startCol = startCol;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  setValues(values: unknown[][]): void {
    this.sheet.writeRect(this.startRow, this.startCol, this.numRows, this.numCols, values);
  }

  setValue(value: unknown): void {
    this.sheet.writeRect(this.startRow, this.startCol, 1, 1, [[value]]);
  }

  clearContent(): void {
    this.sheet.clearRect(this.startRow, this.startCol, this.numRows, this.numCols);
  }
}

export class MockSheet {
  readonly name: string;
  private rows: unknown[][] = [];
  private frozenRows = 0;
  private setValuesCount = 0;
  clearContentsCallCount = 0;
  private readonly faultHooks: SheetFaultHooks;

  constructor(name: string, faultHooks: SheetFaultHooks) {
    this.name = name;
    this.faultHooks = faultHooks;
  }

  getDataRange(): { getValues: () => unknown[][] } {
    return {
      getValues: () => this.rows.map((row) => [...row]),
    };
  }

  getLastRow(): number {
    return this.rows.length;
  }

  getLastColumn(): number {
    let maxCols = 0;
    for (const row of this.rows) {
      if (row.length > maxCols) {
        maxCols = row.length;
      }
    }
    return maxCols;
  }

  appendRow(row: unknown[]): void {
    this.rows.push([...row]);
  }

  setFrozenRows(count: number): void {
    this.frozenRows = count;
  }

  getFrozenRows(): number {
    return this.frozenRows;
  }

  clearContents(): void {
    this.clearContentsCallCount += 1;
    this.rows = [];
  }

  getRange(row: number, col: number, numRows: number, numCols: number): MockRange {
    return new MockRange(this, row, col, numRows, numCols);
  }

  writeRect(
    startRow: number,
    startCol: number,
    numRows: number,
    numCols: number,
    values: unknown[][]
  ): void {
    this.setValuesCount += 1;
    if (this.faultHooks.onBeforeSetValues) {
      this.faultHooks.onBeforeSetValues(this.name, this.setValuesCount);
    }

    if (values.length !== numRows) {
      throw new Error(`setValues row count mismatch: expected ${numRows}, got ${values.length}`);
    }

    for (let r = 0; r < numRows; r++) {
      const srcRow = values[r];
      if (!srcRow || srcRow.length !== numCols) {
        throw new Error(`setValues col count mismatch at row ${r}`);
      }
      const targetRowIdx = startRow - 1 + r;
      while (this.rows.length <= targetRowIdx) {
        this.rows.push([]);
      }
      const targetRow = this.rows[targetRowIdx]!;
      while (targetRow.length < startCol - 1 + numCols) {
        targetRow.push('');
      }
      for (let c = 0; c < numCols; c++) {
        targetRow[startCol - 1 + c] = srcRow[c];
      }
    }
  }

  clearRect(startRow: number, startCol: number, numRows: number, numCols: number): void {
    for (let r = 0; r < numRows; r++) {
      const targetRowIdx = startRow - 1 + r;
      const targetRow = this.rows[targetRowIdx];
      if (!targetRow) continue;
      for (let c = 0; c < numCols; c++) {
        const colIdx = startCol - 1 + c;
        if (colIdx < targetRow.length) {
          targetRow[colIdx] = '';
        }
      }
    }
    while (this.rows.length > 0 && this.isRowBlank(this.rows[this.rows.length - 1])) {
      this.rows.pop();
    }
  }

  private isRowBlank(row: unknown[] | undefined): boolean {
    if (!row) return true;
    return row.every((cell) => cell === '' || cell === null || cell === undefined);
  }

  setRawRows(rows: unknown[][]): void {
    this.rows = rows.map((row) => [...row]);
  }

  getRawRows(): unknown[][] {
    return this.rows.map((row) => [...row]);
  }
}

export class MockSpreadsheet {
  readonly id: string;
  private readonly sheets = new Map<string, MockSheet>();
  private readonly faultHooks: SheetFaultHooks;

  constructor(id: string, faultHooks: SheetFaultHooks) {
    this.id = id;
    this.faultHooks = faultHooks;
  }

  getSheetByName(name: string): MockSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): MockSheet {
    const sheet = new MockSheet(name, this.faultHooks);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

export interface GasHarnessFaults {
  forceLockTimeout: boolean;
  onBeforeSetValues?: (sheetName: string, writeAttempt: number) => void;
  onListFolderFiles?: () => void;
  onGetDriveFileById?: (fileId: string) => void;
}

export interface GasTestHarnessOptions {
  passphrase?: string;
  spreadsheetId?: string;
  driveFolderId?: string;
  skipInitialProperties?: boolean;
  initialAppIdentifier?: string;
  sharingAccess?: DriveSharingAccess;
  nowIso?: string;
}

export interface GasHarness {
  properties: Record<string, string>;
  faults: GasHarnessFaults;
  setNowIso: (iso: string) => void;
  setSharingAccess: (access: DriveSharingAccess) => void;
  getSpreadsheet: (id?: string) => MockSpreadsheet;
  getSheet: (name: 'Bottles' | 'Photos' | 'SyncMeta') => MockSheet;
  seedDriveFile: (
    fileId: string,
    bytes: Uint8Array,
    mimeType?: string,
    trashed?: boolean,
    name?: string,
    inFolder?: boolean
  ) => void;
  getDriveFile: (fileId: string) => MockDriveFileRecord | undefined;
  listActiveDriveFileIds: () => string[];
  post: <TResponse = Record<string, unknown>>(body: unknown) => TResponse;
  postRaw: (rawBody: string | null) => Record<string, unknown>;
  get: <TResponse = Record<string, unknown>>() => TResponse;
}

interface TextOutputMock {
  setMimeType: (mimeType: string) => void;
  getContent: () => string;
}

export function createGasTestHarness(options: GasTestHarnessOptions = {}): GasHarness {
  const spreadsheetId = options.spreadsheetId ?? 'test-spreadsheet-id';
  const driveFolderId = options.driveFolderId ?? 'test-drive-folder-id';
  const passphrase = options.passphrase ?? 'super-secret-test-passphrase-32chars';

  const properties: Record<string, string> = options.skipInitialProperties
    ? {}
    : {
        SYNC_PASSPHRASE: passphrase,
        SPREADSHEET_ID: spreadsheetId,
        DRIVE_FOLDER_ID: driveFolderId,
      };

  const faults: GasHarnessFaults = {
    forceLockTimeout: false,
  };

  const sheetFaultHooks: SheetFaultHooks = {
    onBeforeSetValues: (sheetName, attempt) => {
      if (faults.onBeforeSetValues) {
        faults.onBeforeSetValues(sheetName, attempt);
      }
    },
  };

  const spreadsheets = new Map<string, MockSpreadsheet>();
  const mainSs = new MockSpreadsheet(spreadsheetId, sheetFaultHooks);
  spreadsheets.set(spreadsheetId, mainSs);

  if (options.initialAppIdentifier !== undefined) {
    const syncMeta = mainSs.insertSheet('SyncMeta');
    syncMeta.appendRow(['key', 'value', 'updatedAt']);
    syncMeta.appendRow(['appIdentifier', options.initialAppIdentifier, '2026-11-10T00:00:00.000Z']);
  }

  let currentSharingAccess: DriveSharingAccess = options.sharingAccess ?? 'PRIVATE';
  let currentNowMs = Date.parse(options.nowIso ?? '2026-11-19T00:00:00.000Z');
  let driveIdSeq = 1;
  const driveFiles = new Map<string, MockDriveFileRecord>();

  const ControlledDate = class extends Date {
    constructor(value?: string | number | Date) {
      if (value === undefined) {
        super(currentNowMs);
      } else {
        super(value as string | number);
      }
    }

    static override now(): number {
      return currentNowMs;
    }
  };

  const driveFolderMock = {
    getSharingAccess: () => currentSharingAccess,
    getFiles: () => {
      if (faults.onListFolderFiles) {
        faults.onListFolderFiles();
      }
      const list = Array.from(driveFiles.values())
        .filter((rec) => rec.inFolder)
        .map((rec) => new MockDriveFile(rec));
      let idx = 0;
      return {
        hasNext: () => idx < list.length,
        next: () => {
          const item = list[idx];
          idx += 1;
          return item;
        },
      };
    },
    createFile: (blob: MockDriveBlob) => {
      const id = `drive-file-${driveIdSeq++}`;
      const record: MockDriveFileRecord = {
        id,
        name: blob.getName(),
        mimeType: blob.getContentType(),
        bytes: new Uint8Array(blob.getBytes()),
        trashed: false,
        inFolder: true,
      };
      driveFiles.set(id, record);
      return new MockDriveFile(record);
    },
  };

  const sandbox: Record<string, unknown> = {
    Date: ControlledDate,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperties: () => ({ ...properties }),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => !faults.forceLockTimeout,
        releaseLock: () => undefined,
      }),
    },
    ContentService: {
      MimeType: {
        JSON: 'application/json',
      },
      createTextOutput: (content: string): TextOutputMock => {
        return {
          setMimeType: () => undefined,
          getContent: () => content,
        };
      },
    },
    SpreadsheetApp: {
      openById: (id: string) => {
        const ss = spreadsheets.get(id);
        if (!ss) {
          throw new Error(`Spreadsheet not found: ${id}`);
        }
        return ss;
      },
    },
    DriveApp: {
      Access: {
        ANYONE: 'ANYONE',
        ANYONE_WITH_LINK: 'ANYONE_WITH_LINK',
        PRIVATE: 'PRIVATE',
        DOMAIN: 'DOMAIN',
      },
      getFolderById: (id: string) => {
        if (id !== driveFolderId) {
          throw new Error(`Folder not found: ${id}`);
        }
        return driveFolderMock;
      },
      getFileById: (fileId: string) => {
        if (faults.onGetDriveFileById) {
          faults.onGetDriveFileById(fileId);
        }
        const rec = driveFiles.get(fileId);
        if (!rec) {
          throw new Error(`No item with the given ID could be found: ${fileId}`);
        }
        return new MockDriveFile(rec);
      },
    },
    Utilities: {
      base64Decode: (b64: string) => {
        return new Uint8Array(Buffer.from(b64, 'base64'));
      },
      base64Encode: (bytes: Uint8Array) => {
        return Buffer.from(bytes).toString('base64');
      },
      newBlob: (bytes: Uint8Array, mimeType: string, name: string): MockDriveBlob => {
        return {
          getBytes: () => bytes,
          getContentType: () => mimeType,
          getName: () => name,
        };
      },
    },
  };

  const context = vm.createContext(sandbox);
  const gasCodePath = path.resolve(process.cwd(), 'gas/Code.gs');
  const gasSource = fs.readFileSync(gasCodePath, 'utf8');
  vm.runInContext(gasSource, context, { filename: 'gas/Code.gs' });

  const doPostFn = context['doPost'] as ((e: unknown) => TextOutputMock) | undefined;
  const doGetFn = context['doGet'] as (() => TextOutputMock) | undefined;
  if (typeof doPostFn !== 'function' || typeof doGetFn !== 'function') {
    throw new Error('gas/Code.gs did not define doPost / doGet');
  }

  const getOrEnsureSheet = (name: 'Bottles' | 'Photos' | 'SyncMeta'): MockSheet => {
    const existing = mainSs.getSheetByName(name);
    if (existing) return existing;
    return mainSs.insertSheet(name);
  };

  return {
    properties,
    faults,
    setNowIso: (iso: string) => {
      currentNowMs = Date.parse(iso);
    },
    setSharingAccess: (access: DriveSharingAccess) => {
      currentSharingAccess = access;
    },
    getSpreadsheet: (id = spreadsheetId) => {
      const ss = spreadsheets.get(id);
      if (!ss) throw new Error(`Unknown spreadsheet: ${id}`);
      return ss;
    },
    getSheet: (name) => getOrEnsureSheet(name),
    seedDriveFile: (
      fileId,
      bytes,
      mimeType = 'image/jpeg',
      trashed = false,
      name = `seeded-${fileId}.jpg`,
      inFolder = true
    ) => {
      driveFiles.set(fileId, {
        id: fileId,
        name,
        mimeType,
        bytes: new Uint8Array(bytes),
        trashed,
        inFolder,
      });
    },
    getDriveFile: (fileId) => driveFiles.get(fileId),
    listActiveDriveFileIds: () =>
      Array.from(driveFiles.values())
        .filter((f) => !f.trashed)
        .map((f) => f.id)
        .sort(),
    post: <TResponse = Record<string, unknown>>(body: unknown): TResponse => {
      const output = doPostFn({
        postData: {
          contents: JSON.stringify(body),
        },
      });
      return JSON.parse(output.getContent()) as TResponse;
    },
    postRaw: (rawBody: string | null): Record<string, unknown> => {
      const event = rawBody === null ? {} : { postData: { contents: rawBody } };
      const output = doPostFn(event);
      return JSON.parse(output.getContent()) as Record<string, unknown>;
    },
    get: <TResponse = Record<string, unknown>>(): TResponse => {
      const output = doGetFn();
      return JSON.parse(output.getContent()) as TResponse;
    },
  };
}
