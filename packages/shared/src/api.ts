export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export function createApiError(code: string, message: string, details: Record<string, unknown> = {}): ApiErrorEnvelope {
  return { error: { code, message, details } };
}
