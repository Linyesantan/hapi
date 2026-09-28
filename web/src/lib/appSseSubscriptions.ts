export type AppSseSubscription = {
    all: true
    selectedMessagesOnly: true
    sessionId?: string
}

export function getAppSseSubscription(
    selectedSessionId: string | null | undefined
): AppSseSubscription {
    return {
        all: true,
        selectedMessagesOnly: true,
        ...(selectedSessionId ? { sessionId: selectedSessionId } : {})
    }
}
