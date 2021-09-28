import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { DRE, increaseTime, timeLatest, waitForTx } from '../helpers/misc-utils';
import { MAX_UINT_AMOUNT, RAY } from '../helpers/constants';
import { ProtocolErrors, RateMode } from '../helpers/types';
import {
  MockFlashLoanReceiverFactory,
  PriceOracleSentinel,
  PriceOracleSentinelFactory,
  SequencerOracle,
  SequencerOracleFactory,
} from '../types';
import { getFirstSigner } from '../helpers/contracts-getters';
import { makeSuite, TestEnv } from './helpers/make-suite';
import { convertToCurrencyDecimals } from '../helpers/contracts-helpers';
import { calcExpectedVariableDebtTokenBalance } from './helpers/utils/calculations';
import { getReserveData, getUserData } from './helpers/utils/helpers';
import './helpers/utils/wadraymath';

makeSuite('PriceOracleSentinel', (testEnv: TestEnv) => {
  const { VL_PRICE_ORACLE_SENTINEL_FAILED, INVALID_HF } = ProtocolErrors;

  let sequencerOracle: SequencerOracle;
  let priceOracleSentinel: PriceOracleSentinel;

  const GRACE_PERIOD = BigNumber.from(60 * 60);

  before(async () => {
    const { addressesProvider, deployer } = testEnv;

    // Deploy SequencerOracle
    sequencerOracle = await (await new SequencerOracleFactory(deployer.signer).deploy()).deployed();

    priceOracleSentinel = await (
      await new PriceOracleSentinelFactory(await getFirstSigner()).deploy(
        addressesProvider.address,
        sequencerOracle.address,
        GRACE_PERIOD
      )
    ).deployed();
  });

  it('Admin sets a PriceOracleSentinel and activate it for DAI and WETH', async () => {
    const { addressesProvider, configurator, helpersContract, poolAdmin, dai, weth } = testEnv;

    expect(
      await addressesProvider
        .connect(poolAdmin.signer)
        .setPriceOracleSentinel(priceOracleSentinel.address)
    )
      .to.emit(addressesProvider, 'PriceOracleSentinelUpdated')
      .withArgs(priceOracleSentinel.address);

    expect(await addressesProvider.getPriceOracleSentinel()).to.be.eq(priceOracleSentinel.address);

    const answer = await sequencerOracle.latestAnswer();
    expect(answer[0]).to.be.eq(false);
    expect(answer[1]).to.be.eq(0);

    expect(
      await configurator.connect(poolAdmin.signer).setPriceOracleSentinelActive(dai.address, true)
    );
    expect(
      await configurator.connect(poolAdmin.signer).setPriceOracleSentinelActive(weth.address, true)
    );
    expect(await helpersContract.getReservePriceOracleSentinelState(dai.address)).to.be.true;
    expect(await helpersContract.getReservePriceOracleSentinelState(weth.address)).to.be.true;
  });

  it('Flashloan dai and weth, with dai sentinel inactive (expect revert)', async () => {
    const {
      deployer,
      addressesProvider,
      pool,
      configurator,
      helpersContract,
      poolAdmin,
      dai,
      weth,
    } = testEnv;

    expect(
      await configurator.connect(poolAdmin.signer).setPriceOracleSentinelActive(dai.address, false)
    );

    await dai.mint(await convertToCurrencyDecimals(dai.address, '2000'));
    await dai.approve(pool.address, MAX_UINT_AMOUNT);
    await pool.supply(
      dai.address,
      await convertToCurrencyDecimals(dai.address, '2000'),
      deployer.address,
      0
    );

    await weth.mint(await convertToCurrencyDecimals(weth.address, '1'));
    await weth.approve(pool.address, MAX_UINT_AMOUNT);
    await pool.supply(
      weth.address,
      await convertToCurrencyDecimals(weth.address, '1'),
      deployer.address,
      0
    );

    const flashLoanMock = await (
      await new MockFlashLoanReceiverFactory(deployer.signer).deploy(addressesProvider.address)
    ).deployed();

    await expect(
      pool.flashLoan(
        flashLoanMock.address,
        [dai.address, weth.address],
        [1000, 1000],
        [RateMode.Variable, RateMode.Variable],
        deployer.address,
        '0x',
        0
      )
    ).to.be.revertedWith('function call to a non-contract account');

    expect(
      await configurator.connect(poolAdmin.signer).setPriceOracleSentinelActive(dai.address, true)
    );
  });

  it('Borrow DAI', async () => {
    const {
      dai,
      weth,
      users: [depositor, borrower, borrower2],
      pool,
      oracle,
    } = testEnv;

    //mints DAI to depositor
    await dai.connect(depositor.signer).mint(await convertToCurrencyDecimals(dai.address, '2000'));

    //approve protocol to access depositor wallet
    await dai.connect(depositor.signer).approve(pool.address, MAX_UINT_AMOUNT);

    //user 1 deposits 1000 DAI
    const amountDAItoDeposit = await convertToCurrencyDecimals(dai.address, '2000');
    await pool
      .connect(depositor.signer)
      .deposit(dai.address, amountDAItoDeposit, depositor.address, '0');

    const amountETHtoDeposit = await convertToCurrencyDecimals(weth.address, '1');

    for (let i = 0; i < 2; i++) {
      const borrowers = [borrower, borrower2];
      const currBorrower = borrowers[i];
      //mints WETH to borrower
      await weth.connect(currBorrower.signer).mint(amountETHtoDeposit);

      //approve protocol to access borrower wallet
      await weth.connect(currBorrower.signer).approve(pool.address, MAX_UINT_AMOUNT);

      //user 2 deposits 1 WETH
      await pool
        .connect(currBorrower.signer)
        .deposit(weth.address, amountETHtoDeposit, currBorrower.address, '0');

      //user 2 borrows
      const userGlobalData = await pool.getUserAccountData(currBorrower.address);
      const daiPrice = await oracle.getAssetPrice(dai.address);

      const amountDAIToBorrow = await convertToCurrencyDecimals(
        dai.address,
        userGlobalData.availableBorrowsBase.div(daiPrice.toString()).percentMul(9500).toString()
      );

      await pool
        .connect(currBorrower.signer)
        .borrow(dai.address, amountDAIToBorrow, RateMode.Variable, '0', currBorrower.address);
    }
  });

  it('Kill sequencer and drop health factor below 1', async () => {
    const {
      dai,
      users: [, borrower],
      pool,
      oracle,
    } = testEnv;

    const daiPrice = await oracle.getAssetPrice(dai.address);
    await oracle.setAssetPrice(dai.address, daiPrice.percentMul(11000));
    const userGlobalData = await pool.getUserAccountData(borrower.address);

    expect(userGlobalData.healthFactor).to.be.lt(utils.parseUnits('1', 18), INVALID_HF);
    const currAnswer = await sequencerOracle.latestAnswer();
    waitForTx(await sequencerOracle.setAnswer(true, currAnswer[1]));
  });

  it('Tries to liquidate borrower when sequencer is down (HF > 0.95) (revert expected)', async () => {
    const {
      pool,
      dai,
      weth,
      users: [, borrower],
      helpersContract,
    } = testEnv;

    await dai.mint(await convertToCurrencyDecimals(dai.address, '1000'));
    await dai.approve(pool.address, MAX_UINT_AMOUNT);

    const userReserveDataBefore = await getUserData(
      pool,
      helpersContract,
      dai.address,
      borrower.address
    );

    const amountToLiquidate = userReserveDataBefore.currentVariableDebt.div(2);
    await expect(
      pool.liquidationCall(weth.address, dai.address, borrower.address, amountToLiquidate, true)
    ).to.be.revertedWith(VL_PRICE_ORACLE_SENTINEL_FAILED);
  });

  it('Drop health factor lower', async () => {
    const {
      dai,
      users: [, borrower],
      pool,
      oracle,
    } = testEnv;

    const daiPrice = await oracle.getAssetPrice(dai.address);
    await oracle.setAssetPrice(dai.address, daiPrice.percentMul(11000));
    const userGlobalData = await pool.getUserAccountData(borrower.address);

    expect(userGlobalData.healthFactor).to.be.lt(utils.parseUnits('1', 18), INVALID_HF);
  });

  it('Liquidates borrower when sequencer is down (HF < 0.95)', async () => {
    const {
      pool,
      dai,
      weth,
      users: [, borrower],
      oracle,
      helpersContract,
      deployer,
    } = testEnv;

    await dai.mint(await convertToCurrencyDecimals(dai.address, '1000'));
    await dai.approve(pool.address, MAX_UINT_AMOUNT);

    const daiReserveDataBefore = await getReserveData(helpersContract, dai.address);
    const ethReserveDataBefore = await getReserveData(helpersContract, weth.address);

    const userReserveDataBefore = await getUserData(
      pool,
      helpersContract,
      dai.address,
      borrower.address
    );

    const userWethReserveDataBefore = await getUserData(
      pool,
      helpersContract,
      weth.address,
      borrower.address
    );

    const amountToLiquidate = userReserveDataBefore.currentVariableDebt.div(2);

    const tx = await pool.liquidationCall(
      weth.address,
      dai.address,
      borrower.address,
      amountToLiquidate,
      true
    );

    const userReserveDataAfter = await helpersContract.getUserReserveData(
      dai.address,
      borrower.address
    );

    const userWethReserveDataAfter = await helpersContract.getUserReserveData(
      weth.address,
      borrower.address
    );

    const daiReserveDataAfter = await getReserveData(helpersContract, dai.address);
    const ethReserveDataAfter = await getReserveData(helpersContract, weth.address);

    const collateralPrice = await oracle.getAssetPrice(weth.address);
    const principalPrice = await oracle.getAssetPrice(dai.address);

    const collateralDecimals = (await helpersContract.getReserveConfigurationData(weth.address))
      .decimals;
    const principalDecimals = (await helpersContract.getReserveConfigurationData(dai.address))
      .decimals;

    const expectedCollateralLiquidated = principalPrice
      .mul(amountToLiquidate)
      .percentMul(10500)
      .mul(BigNumber.from(10).pow(collateralDecimals))
      .div(collateralPrice.mul(BigNumber.from(10).pow(principalDecimals)));

    expect(expectedCollateralLiquidated).to.be.closeTo(
      userWethReserveDataBefore.currentATokenBalance.sub(
        userWethReserveDataAfter.currentATokenBalance
      ),
      2,
      'Invalid collateral amount liquidated'
    );

    if (!tx.blockNumber) {
      expect(false, 'Invalid block number');
      return;
    }

    const txTimestamp = BigNumber.from(
      (await DRE.ethers.provider.getBlock(tx.blockNumber)).timestamp
    );

    const variableDebtBeforeTx = calcExpectedVariableDebtTokenBalance(
      daiReserveDataBefore,
      userReserveDataBefore,
      txTimestamp
    );

    expect(userReserveDataAfter.currentVariableDebt).to.be.closeTo(
      variableDebtBeforeTx.sub(amountToLiquidate),
      2,
      'Invalid user borrow balance after liquidation'
    );

    expect(daiReserveDataAfter.availableLiquidity).to.be.closeTo(
      daiReserveDataBefore.availableLiquidity.add(amountToLiquidate),
      2,
      'Invalid principal available liquidity'
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(daiReserveDataAfter.liquidityIndex).to.be.gte(
      daiReserveDataBefore.liquidityIndex,
      'Invalid liquidity index'
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(daiReserveDataAfter.liquidityRate).to.be.lt(
      daiReserveDataBefore.liquidityRate,
      'Invalid liquidity APY'
    );

    expect(ethReserveDataAfter.availableLiquidity).to.be.closeTo(
      ethReserveDataBefore.availableLiquidity,
      2,
      'Invalid collateral available liquidity'
    );

    expect(
      (await helpersContract.getUserReserveData(weth.address, deployer.address))
        .usageAsCollateralEnabled
    ).to.be.true;
  });

  it('User tries to borrow (revert expected)', async () => {
    const {
      dai,
      weth,
      users: [, , , user],
      pool,
      oracle,
    } = testEnv;

    await weth.connect(user.signer).mint(utils.parseUnits('1', 18));
    await weth.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(user.signer)
      .supply(weth.address, utils.parseUnits('1', 18), user.address, 0);

    await expect(
      pool
        .connect(user.signer)
        .borrow(dai.address, utils.parseUnits('100', 18), RateMode.Variable, 0, user.address)
    ).to.be.revertedWith(VL_PRICE_ORACLE_SENTINEL_FAILED);
  });

  it('Turn on sequencer', async () => {
    await waitForTx(await sequencerOracle.setAnswer(false, await timeLatest()));
  });

  it('User tries to borrow (revert expected)', async () => {
    const {
      dai,
      weth,
      users: [, , , user],
      pool,
    } = testEnv;

    await weth.connect(user.signer).mint(utils.parseUnits('1', 18));
    await weth.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(user.signer)
      .supply(weth.address, utils.parseUnits('1', 18), user.address, 0);

    await expect(
      pool
        .connect(user.signer)
        .borrow(dai.address, utils.parseUnits('100', 18), RateMode.Variable, 0, user.address)
    ).to.be.revertedWith(VL_PRICE_ORACLE_SENTINEL_FAILED);
  });

  it('Turn off sequencer + increase time more than grace period', async () => {
    const currAnswer = await sequencerOracle.latestAnswer();
    await waitForTx(await sequencerOracle.setAnswer(true, currAnswer[1]));
    await increaseTime(GRACE_PERIOD.mul(2).toNumber());
  });

  it('User tries to borrow (revert expected)', async () => {
    const {
      dai,
      weth,
      users: [, , , user],
      pool,
    } = testEnv;

    await weth.connect(user.signer).mint(utils.parseUnits('1', 18));
    await weth.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(user.signer)
      .supply(weth.address, utils.parseUnits('1', 18), user.address, 0);

    await expect(
      pool
        .connect(user.signer)
        .borrow(dai.address, utils.parseUnits('100', 18), RateMode.Variable, 0, user.address)
    ).to.be.revertedWith(VL_PRICE_ORACLE_SENTINEL_FAILED);
  });

  it('Turn on sequencer + increase time past grace period', async () => {
    await waitForTx(await sequencerOracle.setAnswer(false, await timeLatest()));
    await increaseTime(GRACE_PERIOD.mul(2).toNumber());
  });

  it('User tries to borrow', async () => {
    const {
      dai,
      weth,
      users: [, , , user],
      pool,
    } = testEnv;

    await weth.connect(user.signer).mint(utils.parseUnits('1', 18));
    await weth.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT);
    await pool
      .connect(user.signer)
      .supply(weth.address, utils.parseUnits('1', 18), user.address, 0);

    await waitForTx(
      await pool
        .connect(user.signer)
        .borrow(dai.address, utils.parseUnits('100', 18), RateMode.Variable, 0, user.address)
    );
  });

  it('Increase health factor', async () => {
    const {
      dai,
      users: [, borrower],
      pool,
      oracle,
    } = testEnv;
    const daiPrice = await oracle.getAssetPrice(dai.address);
    await oracle.setAssetPrice(dai.address, daiPrice.percentMul(9500));
    const userGlobalData = await pool.getUserAccountData(borrower.address);

    expect(userGlobalData.healthFactor).to.be.lt(utils.parseUnits('1', 18), INVALID_HF);
    expect(userGlobalData.healthFactor).to.be.gt(utils.parseUnits('0.95', 18), INVALID_HF);
  });

  it('Liquidates borrower when sequencer is up again', async () => {
    const {
      pool,
      dai,
      weth,
      users: [, , borrower],
      oracle,
      helpersContract,
      deployer,
    } = testEnv;

    await dai.mint(await convertToCurrencyDecimals(dai.address, '1000'));
    await dai.approve(pool.address, MAX_UINT_AMOUNT);

    const daiReserveDataBefore = await getReserveData(helpersContract, dai.address);
    const ethReserveDataBefore = await getReserveData(helpersContract, weth.address);

    const userReserveDataBefore = await getUserData(
      pool,
      helpersContract,
      dai.address,
      borrower.address
    );

    const userWethReserveDataBefore = await getUserData(
      pool,
      helpersContract,
      weth.address,
      borrower.address
    );

    const amountToLiquidate = userReserveDataBefore.currentVariableDebt.div(2);

    // The supply is the same, but there should be a change in who has what. The liquidator should have received what the borrower lost.
    const tx = await pool.liquidationCall(
      weth.address,
      dai.address,
      borrower.address,
      amountToLiquidate,
      true
    );

    const userReserveDataAfter = await helpersContract.getUserReserveData(
      dai.address,
      borrower.address
    );

    const userWethReserveDataAfter = await helpersContract.getUserReserveData(
      weth.address,
      borrower.address
    );

    const userGlobalDataAfter = await pool.getUserAccountData(borrower.address);

    const daiReserveDataAfter = await getReserveData(helpersContract, dai.address);
    const ethReserveDataAfter = await getReserveData(helpersContract, weth.address);

    const collateralPrice = await oracle.getAssetPrice(weth.address);
    const principalPrice = await oracle.getAssetPrice(dai.address);

    const collateralDecimals = (await helpersContract.getReserveConfigurationData(weth.address))
      .decimals;
    const principalDecimals = (await helpersContract.getReserveConfigurationData(dai.address))
      .decimals;

    const expectedCollateralLiquidated = principalPrice
      .mul(amountToLiquidate)
      .percentMul(10500)
      .mul(BigNumber.from(10).pow(collateralDecimals))
      .div(collateralPrice.mul(BigNumber.from(10).pow(principalDecimals)));

    expect(expectedCollateralLiquidated).to.be.closeTo(
      userWethReserveDataBefore.currentATokenBalance.sub(
        userWethReserveDataAfter.currentATokenBalance
      ),
      2,
      'Invalid collateral amount liquidated'
    );

    if (!tx.blockNumber) {
      expect(false, 'Invalid block number');
      return;
    }

    const txTimestamp = BigNumber.from(
      (await DRE.ethers.provider.getBlock(tx.blockNumber)).timestamp
    );

    const variableDebtBeforeTx = calcExpectedVariableDebtTokenBalance(
      daiReserveDataBefore,
      userReserveDataBefore,
      txTimestamp
    );

    expect(userReserveDataAfter.currentVariableDebt).to.be.closeTo(
      variableDebtBeforeTx.sub(amountToLiquidate),
      2,
      'Invalid user borrow balance after liquidation'
    );

    expect(daiReserveDataAfter.availableLiquidity).to.be.closeTo(
      daiReserveDataBefore.availableLiquidity.add(amountToLiquidate),
      2,
      'Invalid principal available liquidity'
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(daiReserveDataAfter.liquidityIndex).to.be.gte(
      daiReserveDataBefore.liquidityIndex,
      'Invalid liquidity index'
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(daiReserveDataAfter.liquidityRate).to.be.lt(
      daiReserveDataBefore.liquidityRate,
      'Invalid liquidity APY'
    );

    expect(ethReserveDataAfter.availableLiquidity).to.be.closeTo(
      ethReserveDataBefore.availableLiquidity,
      2,
      'Invalid collateral available liquidity'
    );

    expect(
      (await helpersContract.getUserReserveData(weth.address, deployer.address))
        .usageAsCollateralEnabled
    ).to.be.true;
  });
});
