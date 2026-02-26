export const runLetteringWorker = async (payload: Record<string, unknown>) => {
  return {
    lettered: true,
    payload,
    completedAt: Date.now()
  };
};
