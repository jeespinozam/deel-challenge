const express = require('express');
const bodyParser = require('body-parser');
const { Op } = require('sequelize');
const { sequelize } = require('./model');
const { getProfile } = require('./middleware/getProfile');
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

/**
 * @returns contract by id only if it belongs to the user (contractor or client)
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
	const { Contract } = req.app.get('models');
	const { id } = req.params;
	const { profile } = req;
	const contract = await Contract.findOne({
		where: {
			id,
			[Op.or]: [{ ContractorId: profile.id }, { ClientId: profile.id }]
		}
	});
	if (!contract)
		return res
			.json(`Contract with id ${id} not found for this user`)
			.status(404)
			.end();
	return res.json(contract);
});

/**
 * @returns non terminated contracts belonging to a user (client or contractor)
 */
app.get('/contracts', getProfile, async (req, res) => {
	const { Contract } = req.app.get('models');
	const { profile } = req;
	const contracts = await Contract.findAll({
		where: {
			[Op.or]: [{ ContractorId: profile.id }, { ClientId: profile.id }],
			status: {
				[Op.ne]: 'terminated'
			}
		}
	});
	if (!contracts.length)
		return res.json('Contracts not found for this user').status(404).end();
	return res.json(contracts);
});

/**
 * @returns all unpaid jobs for a user (client or contractor), for active contracts only (status in_progress)
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
	const { Job, Contract } = req.app.get('models');
	const { profile } = req;
	const jobs = await Job.findAll({
		where: {
			paid: null
		},
		include: {
			model: Contract,
			required: true,
			where: {
				status: 'in_progress',
				[Op.or]: [
					{ ContractorId: profile.id },
					{ ClientId: profile.id }
				]
			}
		}
	});
	if (!jobs.length)
		return res.json('Jobs not found for this user').status(404).end();
	return res.json(jobs);
});

/**
 * @description Pay for a job, a client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance.
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
	const { Job, Contract } = req.app.get('models');
	const { profile } = req;
	const { job_id } = req.params;
	if (profile.type !== 'client') {
		return res
			.json('You are not authorized to pay a contractor')
			.status(401)
			.end();
	}

	const t = await sequelize.transaction();
	try {
		// check if the job is unpaid
		const job = await Job.findOne({
			where: {
				id: job_id,
				paid: null
			},
			include: {
				model: Contract,
				required: true,
				where: {
					status: 'in_progress',
					ClientId: profile.id
				},
				include: ['Contractor']
			},
			transaction: t
		});
		if (!job) {
			return res
				.json('This job is not valid to get paid')
				.status(500)
				.end();
		}
		if (profile.balance < job.price) {
			return res
				.json('Your balance is not enough for this payment')
				.status(401)
				.end();
		}
		// setting the job as paid
		job.paid = 1;
		job.paymentDate = new Date();

		// moving the money to the contractor
		const contractor = job.Contract.Contractor;
		contractor.balance = contractor.balance + job.price;

		// removing the money from the client
		profile.balance = profile.balance - job.price;

		await job.save({ transaction: t });
		await contractor.save({ transaction: t });
		await profile.save({ transaction: t });

		await t.commit();
		return res.json('Job successfully paid').status(200).end();
	} catch (error) {
		console.error({ error });
		await t.rollback();
		return res.json('Something went wrong').status(500).end();
	}
});

/**
 * @description Deposits money into the the the balance of a client,
 * a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
 */
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
	const { Job, Contract } = req.app.get('models');
	const { profile } = req;
	const amount = parseFloat(req.body.amount);
	const userId = parseFloat(req.params.userId);
	if (profile.type !== 'client' || userId !== profile.id) {
		return res
			.json('You are not authorized to deposit money into this account')
			.status(401)
			.end();
	}
	if (isNaN(amount)) {
		return res.json('Incorrect value for amount').status(500).end();
	}
	if (amount < 0) {
		return res.json('You cant deposit negative values').status(500).end();
	}

	const t = await sequelize.transaction();
	try {
		// check the jobs to pay
		const result = await Job.findAll({
			where: {
				paid: null
			},
			include: {
				model: Contract,
				required: true,
				attributes: ['ClientId'],
				where: {
					status: 'in_progress',
					ClientId: profile.id
				}
			},
			attributes: [
				[sequelize.fn('sum', sequelize.col('price')), 'total_amount']
			],
			group: ['ClientId'],
			raw: true,
			transaction: t
		});
		const max = parseFloat(result.total_amount) * 0.25;

		if (amount > max) {
			return res
				.json(
					`You cant deposit more than 25% your total of jobs to pay. Max amount: ${max}`
				)
				.status(500)
				.end();
		}

		// moving the money to the client
		profile.balance = profile.balance + amount;
		await profile.save({ transaction: t });

		await t.commit();
		return res.json('Deposit successfully created').status(200).end();
	} catch (error) {
		console.error({ error });
		await t.rollback();
		return res.json('Something went wrong').status(500).end();
	}
});

/**
 * @description Returns the profession that earned the most money (sum of jobs paid)
 * for any contactor that worked in the query time range
 */
app.get('/admin/best-profession', async (req, res) => {
	const { Job, Contract, Profile } = req.app.get('models');
	const { start, end } = req.query;

	try {
		// check the jobs paid with contract terminated
		const totalsByContractor = await Job.findAll({
			where: {
				paid: 1,
				paymentDate: {
					[Op.between]: [start, end]
				}
			},
			include: {
				model: Contract,
				required: true,
				attributes: [],
				where: {
					status: 'terminated'
				},
				include: {
					model: Profile,
					required: true,
					as: 'Contractor',
					attributes: ['profession']
				}
			},
			attributes: [
				[sequelize.fn('sum', sequelize.col('price')), 'total_amount']
			],
			raw: true,
			group: ['profession'],
			order: [['total_amount', 'DESC']],
			limit: 1
		});

		if (!totalsByContractor.length) {
			return res
				.json(`No data found for this period ${start}-${end}`)
				.status(500)
				.end();
		}

		return res
			.json(
				`The profession that earned the most money is ${totalsByContractor[0]['Contract.Contractor.profession']}`
			)
			.status(200)
			.end();
	} catch (error) {
		console.error({ error });
		return res.json('Something went wrong').status(500).end();
	}
});

/**
 * @description returns the clients the paid the most for jobs in the query time period.
 * limit query parameter should be applied, default limit is 2
 */
app.get('/admin/best-clients', async (req, res) => {
	const { Job, Contract, Profile } = req.app.get('models');
	const { start, end, limit = 1 } = req.query;

	try {
		// check the jobs paid with contract terminated
		const totalsByClient = await Job.findAll({
			where: {
				paid: 1,
				paymentDate: {
					[Op.between]: [start, end]
				}
			},
			include: {
				model: Contract,
				required: true,
				attributes: [],
				where: {
					status: 'terminated'
				},
				include: {
					model: Profile,
					required: true,
					as: 'Client',
					attributes: []
				}
			},
			attributes: [
				[sequelize.literal('Contract.ClientId'), 'id'],
				[
					sequelize.literal(`firstName || ' '  || lastName`),
					'fullName'
				],
				[sequelize.fn('sum', sequelize.col('price')), 'paid']
			],
			group: ['ClientId'],
			order: [['paid', 'DESC']],
			limit
		});

		if (!totalsByClient.length) {
			return res
				.json(`No data found for this period ${start}-${end}`)
				.status(500)
				.end();
		}

		return res.json(totalsByClient).status(200).end();
	} catch (error) {
		console.error({ error });
		return res.json('Something went wrong').status(500).end();
	}
});
module.exports = app;
