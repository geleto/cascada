import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/index.js';

describe('Script documentation examples', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  it('runs the sequence channel example with ordered reads and nested calls', async function () {
    const script = `
      sequence db = services.db
      var user = db.getUser(1)
      var state = db.connectionState
      var id = db.api.client.getId()

      return { user: user, state: state, id: id, log: db.snapshot() }
    `;
    const log = [];
    const db = {
      connectionState: 'open',
      getUser(id) {
        log.push(`getUser:${id}`);
        return {id, name: 'Ada'};
      },
      api: {
        client: {
          getId() {
            log.push('getId');
            return 'client-1';
          }
        }
      },
      snapshot() {
        return log.slice();
      }
    };

    const result = await env.renderScriptString(script, {services: {db}});
    expect(result).to.eql({
      user: {id: 1, name: 'Ada'},
      state: 'open',
      id: 'client-1',
      log: ['getUser:1', 'getId']
    });
  });
});
