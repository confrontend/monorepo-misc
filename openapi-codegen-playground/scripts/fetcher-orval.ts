export const customFetcher = async <T>(request: RequestInfo, init?: RequestInit): Promise<T> => {
  const response = await fetch(request, init);

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
};
