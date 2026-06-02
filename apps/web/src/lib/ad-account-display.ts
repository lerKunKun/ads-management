interface FbAccountNameLike {
  id: string;
  name?: string | null;
}

interface AdAccountNameLike {
  name?: string | null;
  fbAccountId?: string | null;
}

export function createFbAccountNameMap(accounts: FbAccountNameLike[]): Map<string, string> {
  return new Map(accounts.map((account) => [account.id, account.name ?? '']));
}

export function isFbNameDuplicateAdAccount(
  account: AdAccountNameLike,
  fbNameById: Map<string, string>,
): boolean {
  if (!account.fbAccountId) return false;
  const adName = normalizeAccountName(account.name);
  const fbName = normalizeAccountName(fbNameById.get(account.fbAccountId));
  return adName.length > 0 && fbName.length > 0 && adName === fbName;
}

export function filterFbNameDuplicateAdAccounts<T extends AdAccountNameLike>(
  accounts: T[],
  fbNameById: Map<string, string>,
): T[] {
  return accounts.filter((account) => !isFbNameDuplicateAdAccount(account, fbNameById));
}

function normalizeAccountName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}
