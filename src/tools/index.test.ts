import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { applyPatch, getTestCommand, findRelevantFiles, sanitizeErrorTrace, extractKeywordsAndPaths, checkSyntax, auditFileSystemAndImports, crawlWorkspace } from './index.js';

const tempDir = path.resolve('temp_test_dir');

describe('Giga CLI Tools', () => {
  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('applyPatch', () => {
    it('should correctly replace a range of lines in a file', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n', 'utf8');

      // Replace Line 2 to Line 4 (inclusive, 1-indexed)
      applyPatch(filePath, 2, 4, 'Line Two\nLine Three\nLine Four');

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe('Line 1\nLine Two\nLine Three\nLine Four\nLine 5\n');
    });

    it('should handle replacing single line', () => {
      const filePath = path.join(tempDir, 'test.txt');
      fs.writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\n', 'utf8');

      // Replace line 2
      applyPatch(filePath, 2, 2, 'New Line 2');

      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe('Line 1\nNew Line 2\nLine 3\n');
    });
  });

  describe('getTestCommand', () => {
    it('should retrieve custom test command from package.json if it exists', () => {
      const packageJsonPath = path.join(tempDir, 'package.json');
      fs.writeFileSync(packageJsonPath, JSON.stringify({
        scripts: {
          test: 'vitest run'
        }
      }), 'utf8');

      const cmd = getTestCommand(tempDir);
      expect(cmd).toBe('npm test');
    });

    it('should default to npm test if package.json does not exist or have scripts.test', () => {
      const cmd = getTestCommand(tempDir);
      expect(cmd).toBe('npm test');
    });
  });

  describe('findRelevantFiles', () => {
    it('should list all matching files based on keyword matching', () => {
      const file1 = path.join(tempDir, 'user_auth.ts');
      const file2 = path.join(tempDir, 'database.ts');
      const file3 = path.join(tempDir, 'readme.md');

      fs.writeFileSync(file1, '// auth logic here\nexport function login() {}', 'utf8');
      fs.writeFileSync(file2, '// database client setup\nexport const db = {}', 'utf8');
      fs.writeFileSync(file3, '# project description\nSome read me stuff', 'utf8');

      const relevant = findRelevantFiles(tempDir, ['auth']);
      expect(relevant).toContain('user_auth.ts');
      expect(relevant).not.toContain('database.ts');
      expect(relevant).not.toContain('readme.md');
    });

    it('should list all code files when keywords is empty', () => {
      const file1 = path.join(tempDir, 'app.ts');
      const file2 = path.join(tempDir, 'logo.png');

      fs.writeFileSync(file1, 'const a = 1;', 'utf8');
      fs.writeFileSync(file2, '', 'utf8');

      const allCodeFiles = findRelevantFiles(tempDir, []);
      expect(allCodeFiles).toContain('app.ts');
      expect(allCodeFiles).not.toContain('logo.png');
    });
  });

  describe('sanitizeErrorTrace', () => {
    it('should not modify traces shorter than or equal to 1500 characters', () => {
      const shortTrace = 'A'.repeat(1500);
      expect(sanitizeErrorTrace(shortTrace)).toBe(shortTrace);
    });

    it('should truncate traces longer than 1500 characters and insert notice', () => {
      const longTrace = 'A'.repeat(600) + 'B'.repeat(1000); // 1600 characters total
      const sanitized = sanitizeErrorTrace(longTrace);
      expect(sanitized.length).toBe(1500 + '[... verbose test logs truncated for token safety ...]'.length);
      expect(sanitized.slice(0, 500)).toBe('A'.repeat(500));
      expect(sanitized.slice(-1000)).toBe('B'.repeat(1000));
      expect(sanitized).toContain('[... verbose test logs truncated for token safety ...]');
    });
  });

  describe('extractKeywordsAndPaths', () => {
    it('should extract paths and keywords correctly from backticks and text', () => {
      const text = 'Failed to load config file `src/config.json`, error inside `fs.readFileSync` for `README.md`';
      const result = extractKeywordsAndPaths(text);
      expect(result.paths).toContain('src/config.json');
      expect(result.paths).toContain('README.md');
      expect(result.keywords).toContain('fs.readFileSync');
    });
  });

  describe('checkSyntax', () => {
    it('should validate JSON files correctly', () => {
      const validJson = '{"a": 1, "b": "test"}';
      const invalidJson = '{"a": 1, "b": "test"';
      expect(checkSyntax(validJson, 'test.json')).toBeNull();
      expect(checkSyntax(invalidJson, 'test.json')).toContain('JSON parse error');
    });

    it('should validate bracket matching in TS/JS files', () => {
      const validCode = 'function test() { const a = [1, 2]; return a; }';
      const invalidCode = 'function test() { const a = [1, 2; return a; }';
      expect(checkSyntax(validCode, 'test.ts')).toBeNull();
      expect(checkSyntax(invalidCode, 'test.ts')).toContain('Mismatched bracket');
    });

    it('should ignore brackets in strings and comments', () => {
      const codeWithComments = 'function test() {\n// closing bracket } is here\nconst s = "}";\n}';
      expect(checkSyntax(codeWithComments, 'test.ts')).toBeNull();
    });
  });

  describe('auditFileSystemAndImports', () => {
    it('should identify missing imports and ignore non-file strings like version numbers', () => {
      // Create a dummy file with a missing import and a version string
      const mainFile = path.join(tempDir, 'main.ts');
      fs.writeFileSync(mainFile, 'import { helper } from "./missing-helper.js";\nconst version = "1.0.1";\nconst val = "some-random-string";', 'utf8');

      const result = auditFileSystemAndImports(tempDir, ['main.ts'], '');
      
      const missingFiles = result.missingFiles.map(m => m.file);
      expect(missingFiles).toContain('./missing-helper.js');
      expect(missingFiles).not.toContain('1.0.1');
      expect(missingFiles).not.toContain('some-random-string');
    });
  });

  describe('crawlWorkspace', () => {
    it('should crawl files and identify matching semantic footprint', () => {
      const file1 = path.join(tempDir, 'file-reader.ts');
      const file2 = path.join(tempDir, 'other.ts');
      fs.writeFileSync(file1, 'import * as fs from "fs";\nconst data = fs.readFileSync("README.md", "utf8");', 'utf8');
      fs.writeFileSync(file2, 'const count = 42;', 'utf8');

      const matches = crawlWorkspace(tempDir, 'Issue complaining about README.md file reading');
      expect(matches).toContain('file-reader.ts');
      expect(matches).not.toContain('other.ts');
    });
  });
});
