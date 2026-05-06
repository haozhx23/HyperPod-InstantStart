import React from 'react';
import { Form, Input, Button, Space, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

/**
 * Reusable env var list input for generic Job panels.
 * Writes to `name` as [{ name, value }, ...].
 */
const EnvVarListField = ({ name = 'envVars', label = 'Environment Variables' }) => (
  <Form.Item label={<Text strong>{label}</Text>}>
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <>
          {fields.map((field) => (
            <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
              <Form.Item
                {...field}
                name={[field.name, 'name']}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder="NAME (leave blank to drop)" style={{ width: 200 }} />
              </Form.Item>
              <Form.Item
                {...field}
                name={[field.name, 'value']}
                style={{ marginBottom: 0 }}
              >
                <Input placeholder="value" style={{ width: 360 }} />
              </Form.Item>
              <MinusCircleOutlined onClick={() => remove(field.name)} />
            </Space>
          ))}
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="dashed" onClick={() => add({ name: '', value: '' })} icon={<PlusOutlined />}>
              Add env var
            </Button>
          </Form.Item>
        </>
      )}
    </Form.List>
  </Form.Item>
);

export default EnvVarListField;
