// Validate that all Lua script files exist and contain key phrases
import * as fs from 'fs'
import * as path from 'path'

const LUA_DIR = path.join(__dirname, '../../../src/lua')

describe('Lua scripts', () => {
  const scripts = ['check.lua', 'check_multi.lua', 'status.lua', 'reset.lua', 'reservoir_fetch.lua']

  test.each(scripts)('%s exists', (script) => {
    const filePath = path.join(LUA_DIR, script)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  test('check.lua contains INCRBY and PEXPIRE', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'check.lua'), 'utf8')
    expect(content).toContain('INCRBY')
    expect(content).toContain('PEXPIRE')
    expect(content).toContain('effective + cost > limit')
  })

  test('check.lua does not increment on deny', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'check.lua'), 'utf8')
    // INCRBY must come AFTER the deny check
    const denyIndex = content.indexOf('effective + cost > limit')
    const incrIndex = content.indexOf('INCRBY')
    expect(incrIndex).toBeGreaterThan(denyIndex)
  })

  test('check_multi.lua checks before incrementing', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'check_multi.lua'), 'utf8')
    // First loop checks, second loop increments
    const firstIncrIndex = content.indexOf('INCRBY')
    const returnDenyIndex = content.indexOf('return {0,')
    expect(returnDenyIndex).toBeLessThan(firstIncrIndex)
  })

  test('status.lua does not contain INCRBY', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'status.lua'), 'utf8')
    expect(content).not.toContain('INCRBY')
    expect(content).not.toContain('PEXPIRE')
  })

  test('reset.lua uses DEL command', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'reset.lua'), 'utf8')
    expect(content).toContain("redis.call('DEL'")
  })

  test('reservoir_fetch.lua uses math.min for granted tokens', () => {
    const content = fs.readFileSync(path.join(LUA_DIR, 'reservoir_fetch.lua'), 'utf8')
    expect(content).toContain('math.min')
    expect(content).toContain('math.floor')
  })

  test('all scripts use tonumber for ARGV values', () => {
    for (const script of scripts) {
      if (script === 'reset.lua') continue // reset.lua has no ARGV
      const content = fs.readFileSync(path.join(LUA_DIR, script), 'utf8')
      expect(content).toContain('tonumber(ARGV')
    }
  })
})
