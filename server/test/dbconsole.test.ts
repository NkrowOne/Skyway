import { describe, expect, it } from 'vitest';
import { assertReadOnly, parseCsv, splitSqlStatements, type DbEngine } from '../src/dbconsole';

const rechaza = (engine: DbEngine, q: string) => expect(() => assertReadOnly(engine, q), `debería rechazar: ${q}`).toThrow();
const acepta = (engine: DbEngine, q: string) => expect(() => assertReadOnly(engine, q), `debería aceptar: ${q}`).not.toThrow();

describe('assertReadOnly', () => {
  it('Mongo: rechaza los métodos de escritura tanto con punto como con corchetes', () => {
    rechaza('mongo', 'db.users.insertOne({a:1})');
    rechaza('mongo', 'db.users["insertOne"]({a:1})');
    rechaza('mongo', "db.getCollection('u')['deleteMany']({})");
    rechaza('mongo', 'db.users[`drop`]()');
    rechaza('mongo', 'db.dropDatabase()');
  });

  it('Mongo: acepta consultas y comandos de solo lectura', () => {
    acepta('mongo', 'db.users.find().limit(10)');
    acepta('mongo', 'db.adminCommand({ listDatabases: 1 })');
    acepta('mongo', 'db.adminCommand({ currentOp: 1, active: true })');
    acepta('mongo', "db.getSiblingDB('x').getCollection('y').countDocuments()");
  });

  it('SQL: examina todos los statements, no solo el primero', () => {
    acepta('mysql', 'SELECT 1; SHOW TABLES');
    rechaza('mysql', 'SELECT 1; DELETE FROM x');
    rechaza('postgres', "SELECT ';'; DROP TABLE x");
    acepta('postgres', "SELECT ';' -- DROP TABLE x");
  });

  it('Redis: examina todas las líneas y los subcomandos', () => {
    rechaza('redis', 'GET x\nDEL x');
    acepta('redis', 'GET x\nTTL x');
    rechaza('redis', 'CLIENT KILL 1');
    acepta('redis', 'CLIENT LIST');
  });
});

describe('splitSqlStatements', () => {
  it('no parte por un punto y coma dentro de una cadena', () => {
    expect(splitSqlStatements("select 'a;b'; select 2")).toEqual(["select 'a;b'", 'select 2']);
  });
});

describe('parseCsv', () => {
  it('respeta las comas entre comillas', () => {
    expect(parseCsv('a,b\n1,"x,y"\n')).toEqual([
      ['a', 'b'],
      ['1', 'x,y'],
    ]);
  });
});
