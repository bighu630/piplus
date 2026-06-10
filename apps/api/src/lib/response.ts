export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}
