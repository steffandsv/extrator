-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Tempo de geração: 08/12/2025 às 16:53
-- Versão do servidor: 11.8.3-MariaDB-log
-- Versão do PHP: 7.2.34

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Banco de dados: `u225637494_fiomb`
--

-- --------------------------------------------------------

--
-- Estrutura para tabela `licitacao_itens`
--

CREATE TABLE `licitacao_itens` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `licitacao_id` varchar(255) NOT NULL,
  `item` varchar(50) NOT NULL,
  `codigo` varchar(100) NOT NULL,
  `descricao` text NOT NULL,
  `unidade` varchar(50) DEFAULT NULL,
  `quantidade` decimal(20,2) DEFAULT NULL,
  `valor_medio` decimal(20,2) DEFAULT NULL,
  `valor_total` decimal(20,2) DEFAULT NULL,
  `lote` varchar(100) DEFAULT NULL,
  `descricao_lote` text DEFAULT NULL,
  `tipo_lance` varchar(100) DEFAULT NULL,
  `reducao_minima` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- --------------------------------------------------------

--
-- Estrutura para tabela `licitacoes`
--

CREATE TABLE `licitacoes` (
  `id` varchar(255) NOT NULL,
  `cd_ibge` int(10) UNSIGNED DEFAULT NULL COMMENT 'Chave estrangeira para a tabela de municípios.',
  `numero_processo` varchar(255) DEFAULT NULL,
  `orgao` varchar(255) DEFAULT NULL,
  `status` varchar(255) DEFAULT NULL,
  `data_final` datetime DEFAULT NULL,
  `objeto` text DEFAULT NULL,
  `modalidade` varchar(255) DEFAULT NULL,
  `visto` tinyint(1) NOT NULL DEFAULT 0,
  `favorito` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `visto2` tinyint(1) DEFAULT 0,
  `favorito2` tinyint(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Estrutura para tabela `municipios`
--

CREATE TABLE `municipios` (
  `CD_IBGE` int(10) UNSIGNED NOT NULL COMMENT 'Código do município conforme o IBGE (7 dígitos).',
  `SG_UF` char(2) NOT NULL COMMENT 'Sigla da Unidade da Federação.',
  `NM_MUNICIPIO` varchar(100) NOT NULL COMMENT 'Nome oficial do município.',
  `DS_LABEL` varchar(255) DEFAULT NULL COMMENT 'Label de exibição do sistema de licitações.',
  `DS_DOMAIN` varchar(255) DEFAULT NULL COMMENT 'Domínio do portal de licitações do município.',
  `LON` decimal(11,8) DEFAULT NULL,
  `LAT` decimal(10,8) DEFAULT NULL,
  `POPULACAO_2021` int(10) UNSIGNED DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Índices para tabelas despejadas
--

--
-- Índices de tabela `licitacao_itens`
--
ALTER TABLE `licitacao_itens`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_licitacao_itens_licitacao` (`licitacao_id`);

--
-- Índices de tabela `licitacoes`
--
ALTER TABLE `licitacoes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_orgao` (`orgao`),
  ADD KEY `idx_data_final` (`data_final`),
  ADD KEY `fk_licitacoes_municipios_idx` (`cd_ibge`);

--
-- Índices de tabela `municipios`
--
ALTER TABLE `municipios`
  ADD PRIMARY KEY (`CD_IBGE`),
  ADD KEY `idx_sg_uf` (`SG_UF`),
  ADD KEY `idx_nm_municipio` (`NM_MUNICIPIO`);

--
-- AUTO_INCREMENT para tabelas despejadas
--

--
-- AUTO_INCREMENT de tabela `licitacao_itens`
--
ALTER TABLE `licitacao_itens`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- Restrições para tabelas despejadas
--

--
-- Restrições para tabelas `licitacoes`
--
ALTER TABLE `licitacoes`
  ADD CONSTRAINT `fk_licitacoes_municipios` FOREIGN KEY (`cd_ibge`) REFERENCES `municipios` (`CD_IBGE`) ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
