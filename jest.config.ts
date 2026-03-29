import type { Config } from 'jest';

const config: Config = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests', '<rootDir>/src', '<rootDir>/scripts'],
	testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				tsconfig: {
					strict: true,
					esModuleInterop: true,
					experimentalDecorators: true,
					emitDecoratorMetadata: true,
				},
			},
		],
	},
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
	coverageDirectory: 'coverage',
	coverageThreshold: {
		global: {
			branches: 100,
			functions: 100,
			lines: 100,
			statements: 100,
		},
	},
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/src/$1',
	},
	testTimeout: 30000,
};

export default config;
