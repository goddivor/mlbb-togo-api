import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateAnthropicDto, UpdateCloudinaryDto } from './integrations.dto';

const errorsOf = <T extends object>(cls: new () => T, body: Record<string, unknown>) =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

describe('integrations DTOs', () => {
  it('accepts model ids with dots, colons, @ and dashes but no slash or space', () => {
    expect(errorsOf(UpdateAnthropicDto, { model: 'claude-opus-5' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { model: 'claude-3-5-sonnet@20240620' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { model: 'us.anthropic.claude:1' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { model: '' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { model: 'a/b' })).toEqual(['model']);
    expect(errorsOf(UpdateAnthropicDto, { model: 'a b' })).toEqual(['model']);
  });

  it('rejects secrets containing whitespace or non printable ASCII', () => {
    expect(errorsOf(UpdateAnthropicDto, { apiKey: 'sk-ant-abc_DEF+/=' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { apiKey: '' })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { apiKey: null })).toEqual([]);
    expect(errorsOf(UpdateAnthropicDto, { apiKey: 'sk-ant abc' })).toEqual(['apiKey']);
    expect(errorsOf(UpdateCloudinaryDto, { apiKey: '123\n' })).toEqual(['apiKey']);
    expect(errorsOf(UpdateCloudinaryDto, { apiSecret: 'sécret' })).toEqual(['apiSecret']);
    expect(errorsOf(UpdateCloudinaryDto, { apiKey: '123456', apiSecret: 'AbC-123_xyz' })).toEqual([]);
  });
});
