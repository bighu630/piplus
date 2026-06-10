import { createApiError } from '@piplus/shared/api';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: createApiError(error.code, error.message, error.details),
    };
  }

  return {
    status: 500,
    body: createApiError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected error'),
  };
}
