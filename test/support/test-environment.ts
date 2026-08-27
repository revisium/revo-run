export const testDatabaseUrl = (): string => {
  const value = process.env['DATABASE_URL'];
  if (value === undefined) {
    throw new Error('DATABASE_URL is required.');
  }
  return value;
};
