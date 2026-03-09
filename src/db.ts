import type { PersistedDirectory, SampleRecord } from "./types";

const DB_NAME = "sample-picker-db";
const DB_VERSION = 1;

const APP_STORE = "app";
const DIRECTORIES_STORE = "directories";
const SAMPLES_STORE = "samples";
const CURRENT_DIRECTORY_KEY = "current-directory-id";

type AppEntry = {
  key: string;
  value: string;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(APP_STORE)) {
        database.createObjectStore(APP_STORE, { keyPath: "key" });
      }

      if (!database.objectStoreNames.contains(DIRECTORIES_STORE)) {
        database.createObjectStore(DIRECTORIES_STORE, { keyPath: "id" });
      }

      if (!database.objectStoreNames.contains(SAMPLES_STORE)) {
        const store = database.createObjectStore(SAMPLES_STORE, {
          keyPath: "id",
        });

        store.createIndex("directoryId", "directoryId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return databasePromise;
}

export async function saveDirectory(
  directory: PersistedDirectory,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(
    [DIRECTORIES_STORE, APP_STORE],
    "readwrite",
  );

  transaction.objectStore(DIRECTORIES_STORE).put(directory);
  transaction.objectStore(APP_STORE).put({
    key: CURRENT_DIRECTORY_KEY,
    value: directory.id,
  } satisfies AppEntry);

  await transactionToPromise(transaction);
}

export async function getCurrentDirectory(): Promise<PersistedDirectory | null> {
  const database = await openDatabase();
  const appTransaction = database.transaction(APP_STORE, "readonly");
  const currentEntry = (await requestToPromise(
    appTransaction.objectStore(APP_STORE).get(CURRENT_DIRECTORY_KEY),
  )) as AppEntry | undefined;

  await transactionToPromise(appTransaction);

  if (!currentEntry) {
    return null;
  }

  const directoryTransaction = database.transaction(DIRECTORIES_STORE, "readonly");
  const directory = await requestToPromise(
    directoryTransaction.objectStore(DIRECTORIES_STORE).get(currentEntry.value),
  );

  await transactionToPromise(directoryTransaction);
  return (directory as PersistedDirectory | undefined) ?? null;
}

export async function getSamplesForDirectory(
  directoryId: string,
): Promise<SampleRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SAMPLES_STORE, "readonly");
  const store = transaction.objectStore(SAMPLES_STORE);
  const index = store.index("directoryId");
  const request = index.getAll(IDBKeyRange.only(directoryId));
  const samples = await requestToPromise(request);

  await transactionToPromise(transaction);

  return (samples as SampleRecord[])
    .map((sample) => ({
      ...sample,
      slotNumber:
        typeof sample.slotNumber === "number" &&
        Number.isInteger(sample.slotNumber) &&
        sample.slotNumber >= 1 &&
        sample.slotNumber <= 999
          ? sample.slotNumber
          : null,
    }))
    .sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, undefined, {
        sensitivity: "base",
      }),
    );
}

export async function replaceSamplesForDirectory(
  directoryId: string,
  samples: SampleRecord[],
): Promise<void> {
  const database = await openDatabase();
  const deleteTransaction = database.transaction(SAMPLES_STORE, "readwrite");
  const deleteStore = deleteTransaction.objectStore(SAMPLES_STORE);
  const deleteIndex = deleteStore.index("directoryId");

  await new Promise<void>((resolve, reject) => {
    const request = deleteIndex.openKeyCursor(IDBKeyRange.only(directoryId));

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      deleteStore.delete(cursor.primaryKey);
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
  });

  await transactionToPromise(deleteTransaction);

  const insertTransaction = database.transaction(SAMPLES_STORE, "readwrite");
  const insertStore = insertTransaction.objectStore(SAMPLES_STORE);

  for (const sample of samples) {
    insertStore.put(sample);
  }

  await transactionToPromise(insertTransaction);
}

export async function updateSampleSlotNumber(
  sampleId: string,
  slotNumber: number | null,
): Promise<void> {
  const database = await openDatabase();
  const readTransaction = database.transaction(SAMPLES_STORE, "readonly");
  const sample = (await requestToPromise(
    readTransaction.objectStore(SAMPLES_STORE).get(sampleId),
  )) as
    | SampleRecord
    | undefined;

  await transactionToPromise(readTransaction);

  if (!sample) {
    return;
  }

  const writeTransaction = database.transaction(SAMPLES_STORE, "readwrite");
  writeTransaction.objectStore(SAMPLES_STORE).put({
    ...sample,
    slotNumber,
  });

  await transactionToPromise(writeTransaction);
}

export async function updateSampleSlotNumbers(
  updates: Array<{ sampleId: string; slotNumber: number | null }>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }

  const database = await openDatabase();
  const readTransaction = database.transaction(SAMPLES_STORE, "readonly");
  const readStore = readTransaction.objectStore(SAMPLES_STORE);
  const samples = await Promise.all(
    updates.map(async ({ sampleId, slotNumber }) => ({
      sample:
        ((await requestToPromise(readStore.get(sampleId))) as
          | SampleRecord
          | undefined) ?? null,
      slotNumber,
    })),
  );

  await transactionToPromise(readTransaction);

  const writeTransaction = database.transaction(SAMPLES_STORE, "readwrite");
  const writeStore = writeTransaction.objectStore(SAMPLES_STORE);

  for (const entry of samples) {
    if (!entry.sample) {
      continue;
    }

    writeStore.put({
      ...entry.sample,
      slotNumber: entry.slotNumber,
    });
  }

  await transactionToPromise(writeTransaction);
}
