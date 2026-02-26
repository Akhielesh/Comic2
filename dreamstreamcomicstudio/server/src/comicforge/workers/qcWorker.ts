export const runQcWorker = async (payload: Record<string, unknown>) => {
  return {
    qcPassed: true,
    payload,
    completedAt: Date.now()
  };
};
