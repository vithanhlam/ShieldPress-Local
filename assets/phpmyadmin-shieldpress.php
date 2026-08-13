<?php
// ShieldPress Local's isolated, loopback-only MariaDB instance.
$cfg['blowfish_secret'] = 'ShieldPressLocal-3307-phpMyAdmin-cookie-secret-2026';
$cfg['Servers'][1] = [
    'auth_type' => 'config',
    'host' => '127.0.0.1',
    'connect_type' => 'tcp',
    'port' => '3307',
    'user' => 'root',
    'password' => '',
    'compress' => false,
    'AllowNoPassword' => true,
];
