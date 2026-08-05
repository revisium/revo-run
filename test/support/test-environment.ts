export const testDatabaseUrl = (): string => {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required.');
  }

  return databaseUrl;
};
