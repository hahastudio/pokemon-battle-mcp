export function jsonToolResponse(data: unknown) {
  return {
    content: [],
    structuredContent: data as Record<string, unknown>,
  };
}

export function errorToolResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

export async function wrapTool<T>(fn: () => Promise<T> | T) {
  try {
    return jsonToolResponse(await fn());
  } catch (error) {
    return errorToolResponse(error);
  }
}
