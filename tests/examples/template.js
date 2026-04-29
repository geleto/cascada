import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/index.js';
import {StringLoader} from '../util.js';

describe('Template documentation examples', function () {
  let env;

  beforeEach(() => {
    env = new AsyncEnvironment();
  });

  it('runs the async comments template example', async function () {
    const template = `
      {% set post = fetchPost(42) %}

      <h1>{{ post.title }}</h1>
      <ul>
        {% for comment in fetchComments(post.id) %}
          <li>{{ comment.author }}: {{ comment.body }}</li>
        {% endfor %}
      </ul>
    `;
    const result = await env.renderTemplateString(template, {
      fetchPost() {
        return {id: 42, title: 'Async Post'};
      },
      fetchComments() {
        return [
          {author: 'Ada', body: 'First'},
          {author: 'Grace', body: 'Second'}
        ];
      }
    });

    expect(result).to.contain('<h1>Async Post</h1>');
    expect(result).to.contain('<li>Ada: First</li>');
    expect(result).to.contain('<li>Grace: Second</li>');
  });

  it('runs the template guard recover example', async function () {
    const template = `
      {% guard %}
        {% set result = riskyCall() %}
        Result: {{ result }}
      {% recover %}
        Could not load result.
      {% endguard %}
    `;
    const result = await env.renderTemplateString(template, {
      riskyCall() {
        throw new Error('boom');
      }
    });

    expect(result.trim()).to.be('Could not load result.');
  });

  it('runs the template sequential repair example', async function () {
    const template = `
      {% do api!.connect() %}

      {% if api! is error %}
        {% do api!! %}
      {% endif %}

      Host: {{ api.host }}
    `;
    const api = {
      host: 'db.local',
      failed: true,
      connect() {
        if (this.failed) {
          this.failed = false;
          throw new Error('temporary outage');
        }
      }
    };

    const result = await env.renderTemplateString(template, {api});
    expect(result.trim()).to.be('Host: db.local');
  });

  it('runs template syntax reference examples for elseif and asyncEach', async function () {
    const template = `
      {% if user.age >= 18 %}
      adult
      {% elseif user.age >= 13 %}
      teen
      {% else %}
      child
      {% endif %}

      {% asyncEach item in items %}
      {{ item }}
      {% endeach %}
    `;
    const result = await env.renderTemplateString(template, {
      user: {age: 15},
      items: ['A', 'B']
    });

    expect(result.replace(/\s+/g, '')).to.be('teenAB');
  });

  it('runs the template inheritance example through StringLoader', async function () {
    const loader = new StringLoader();
    loader.addTemplate('inheritance-base.njk', `
      {% block content(user) with context %}
        Base {{ user }} / {{ siteName }} / {{ theme or "light" }}
      {% endblock %}
    `);
    loader.addTemplate('inheritance-child.njk', `
      {% set theme = "dark" %}
      {% extends "inheritance-base.njk" with theme %}

      {% block content(user) with context %}
        {% set user = "Grace" %}
        Child {{ user }} / {{ siteName }} / {{ super() }}
      {% endblock %}
    `);
    env = new AsyncEnvironment(loader);

    const result = await env.renderTemplate('inheritance-child.njk', {
      user: 'Ada',
      siteName: 'Docs'
    });

    expect(result.replace(/\s+/g, ' ').trim()).to.be('Child Grace / Docs / Base Ada / Docs / dark');
  });
});
