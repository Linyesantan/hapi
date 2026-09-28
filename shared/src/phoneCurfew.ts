/** Matches /usr/local/sbin/time-restricted-ssh-shell and enforce-ssh-curfew.sh.
 * A phone's forwarded loopback address is not a local-console exemption. */
export const PHONE_CURFEW_MESSAGE = 'SSH 宵禁：北京时间周一至周五 00:30–06:00 暂停手机网关连接和操作。已运行的 tmux 任务继续保留，已缓存记录仍可离线查看。'

export function getPhoneCurfew(now = Date.now()) {
    const local = new Date(now + 8 * 60 * 60_000)
    const day = local.getUTCDay()
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
    const restricted = day >= 1 && day <= 5 && minutes >= 30 && minutes < 360
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 60 * 60_000
    let nextChangeAt = restricted ? start + 360 * 60_000 : 0
    if (!restricted) {
        for (let offset = 0; offset <= 7; offset++) {
            const candidateDay = (day + offset) % 7
            const candidate = start + offset * 86_400_000 + 30 * 60_000
            if (candidateDay >= 1 && candidateDay <= 5 && candidate > now) { nextChangeAt = candidate; break }
        }
    }
    return { restricted, nextChangeAt, message: PHONE_CURFEW_MESSAGE }
}
