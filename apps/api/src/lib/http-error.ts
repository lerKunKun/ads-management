/** 业务异常: 携带 HTTP 状态。 */
export class HttpError extends Error {
  constructor(public status: number, public bizCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const Unauthorized = (msg = 'unauthorized') => new HttpError(401, 401, msg);
export const Forbidden = (msg = 'forbidden') => new HttpError(403, 403, msg);
export const NotFound = (msg = 'not found') => new HttpError(404, 404, msg);
