/**
 * Cria um administrador, ou promove a admin um usuário que já existe.
 *
 *   npm run criar-admin -- --email voce@email.com --nome "Seu Nome" --senha "uma-senha-forte"
 *   npm run criar-admin -- --email cliente@email.com     (promove quem já tem conta)
 */
import { parseArgs } from 'node:util';
import { gerarHashSenha } from '../src/auth/senha.js';
import { carregarConfig } from '../src/config.js';
import { criarDbPostgres } from '../src/db/db.js';
import { migrar } from '../src/db/migrar.js';
import { criarUsuario, normalizarEmail } from '../src/usuarios/usuarios.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    nome: { type: 'string' },
    senha: { type: 'string' },
  },
});

if (!values.email) {
  console.error('Informe --email (e --nome e --senha para um usuário novo).');
  process.exit(1);
}

const config = carregarConfig();
const db = criarDbPostgres(config.databaseUrl);
try {
  await migrar(db);
  const email = normalizarEmail(values.email);
  const [existente] = await db.query<{ id: string }>('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existente) {
    await db.query("UPDATE usuarios SET papel = 'admin', ativo = true WHERE id = $1", [existente.id]);
    if (values.senha) {
      await db.query('UPDATE usuarios SET senha_hash = $2 WHERE id = $1', [
        existente.id,
        await gerarHashSenha(values.senha),
      ]);
    }
    console.log(`${email} agora é admin.`);
  } else {
    if (!values.nome || !values.senha || values.senha.length < 8) {
      console.error('Usuário novo: informe --nome e --senha (mínimo de 8 caracteres).');
      process.exit(1);
    }
    await criarUsuario(db, {
      nome: values.nome,
      email,
      celular: null,
      cpf: null,
      senhaHash: await gerarHashSenha(values.senha),
      papel: 'admin',
    });
    console.log(`Admin ${email} criado.`);
  }
} finally {
  await db.fechar();
}
