// 大模型配置：模型名和接口地址在 config/models.json，密钥在环境变量 ARK_API_KEY
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './db.mjs';

export const MODELS = JSON.parse(readFileSync(join(ROOT, 'config', 'models.json'), 'utf8'));
