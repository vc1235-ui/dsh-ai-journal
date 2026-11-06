/**
 * Host 认证 fence：把每个 HTTP 请求委托给 DSH 组成里的 `connection` 服务。
 *
 * `connection.requestRejection(request)` 同时做两件事：
 *   1. Host/Origin fence（防 DNS rebinding、跨站调用）；
 *   2. 浏览器登录 cookie / API 凭据校验（未认证 → 401）。
 *
 * 认证服务不在位（旧版本组成、非 Web 组成）时 fail closed：返回 401，
 * 不退回插件自己的「本机同源」判断。这样即使路由被意外挂载，也不会
 * 在没有宿主认证的情况下泄露会话日报或改写「这不是待办」列表。
 */

/** `connection` 服务缺失或形状不对时的拒绝码。 */
const AUTH_UNAVAILABLE = 401;

/**
 * 计算一个请求应被拒绝的状态码。
 * @param {any} connection - `ctx.get('connection')` 的结果，可能不存在。
 * @param {{ headers?: any }} request - node:http 请求（connection 只读取 headers）。
 * @returns {0 | 401 | 403} `0` 表示放行；其余为应写回的状态码。
 */
export function rejectionForConnection(connection, request) {
  if (connection === null || connection === undefined || typeof connection.requestRejection !== 'function') {
    return AUTH_UNAVAILABLE;
  }
  let rejection;
  try {
    rejection = connection.requestRejection(request);
  } catch {
    /* 认证服务自身异常时同样 fail closed。 */
    return AUTH_UNAVAILABLE;
  }
  if (rejection === undefined) return 0;
  return rejection === 401 || rejection === 403 ? rejection : AUTH_UNAVAILABLE;
}